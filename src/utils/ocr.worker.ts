import * as ort from "onnxruntime-web"; // Use onnxruntime-web for browser compatibility
import det_onnx_url from "@/assets/onnx/PP-OCRv6_small_det_infer.onnx?url";
import rec_onnx_url from "@/assets/onnx/PP-OCRv6_small_rec_infer.onnx?url";
import ppocr_dict_url from "@/assets/onnx/ppocrv6_dict.txt?url";
import { PaddleOcrService, type OrtModule, type PaddleOcrProgressEvent, type RecognitionResult, normalizeInputToRgb } from "paddleocr";
import { distance } from "fastest-levenshtein";
import {
    computeFrameMaxLogits,
    pickLexiconCandidates,
    prepareLexicon,
    rescoreWithLexicon,
} from "@/utils/ocr-lexicon";

let paddleOcrService: PaddleOcrService;
/** 词表 -> 每字的 class 下标，供强制对齐打分复用 */
let lexiconClasses = new Map<string, number[]>();
/** 模型字典，init 时加载，词表编译时需要 */
let ppocr_dict_string: string[] = [];

/**
 * det 预处理的长边上限（像素）。
 *
 * PaddleOCR 默认 `maxSideLimit: 4000`，配合 `limitType: "min"` 会把竖长截图
 * 放大到 4000px 长边（339x1157 的技能面板 → 1184x4000，像素量放大 14倍），
 * det 推理耗时飙到 4.4s。实测把长边限制到 1536 后 det 平均降到 1.3s（3.3x），
 * 识别出的文本与原配置一致率 91~98%，且差异多为"错字变对字"（如 命线→致命线）。
 *
 * 保持 1536 而不是更激进的值，是因为再往下会让小字号文本（技能等级数字）
 * 因插值损失而漏框。若识别漏技能，可临时调回 4000。
 */
const DET_MAX_SIDE_LIMIT = 1536;

/** rec 预处理参数，需与 paddleocr 的 RecognitionService 默认值保持一致 */
const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
// 注意：mean/std 必须是长度为 3 的数组，传标量会让 tensor() 算出 NaN
const REC_MEAN: [number, number, number] = [127.5, 127.5, 127.5];
const REC_STD: [number, number, number] = [1.0 / 127.5, 1.0 / 127.5, 1.0 / 127.5];

/**
 * 技能面板里噪声框的宽度上限（像素），窄于此的框直接跳过 rec。
 *
 * 面板上除了技能名和等级标题，技能图标本身也会被 det 框出来，
 * 图标边缘的高光线条常被 rec 认成单字（金/城/元/环/初/天/步），
 * 既拖慢识别又可能污染后处理。
 *
 * 阈值来自 6 张实测截图共 1043 个框的分布：width<25 的 111 个框里
 * **真实技能名 0 个、等级标签 0 个**，全是噪点；而真实技能名框最窄 32px、
 * 等级标签 32~36px，所以 25 留了足够余量。改这个值前请先跑 ocr-lab。
 */
const SKILL_NOISE_BOX_MAX_WIDTH = 25;

/** 技能面板的图标窄条噪点框：宽度不足且不含完整技能名，直接丢弃 */
const isSkillNoiseBox = (box: { width: number }) => box.width < SKILL_NOISE_BOX_MAX_WIDTH;

/** box 坐标取整后拼成 key，用于把 rec 结果与对应 logits 对上（坐标可能有亚像素误差） */
const boxKeyOf = (box: { x: number; y: number; width: number; height: number }) =>
    `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`;

/** OcrResultItem 的 box 是 [x, y, width, height]，这里转成 boxKeyOf 需要的对象形式 */
const boxKeyOfItem = (item: OcrResultItem) =>
    boxKeyOf({ x: item.box[0], y: item.box[1], width: item.box[2], height: item.box[3] });

const normalizeRecognitionResult = (item: RecognitionResult): OcrResultItem => ({
    text: item.text,
    confidence: item.confidence,
    box: [item.box.x, item.box.y, item.box.width, item.box.height],
});

const toProgressSnapshot = (event: PaddleOcrProgressEvent): OcrProgressSnapshot => {
    if (event.type === "det") {
        return {
            phase: "det",
            stage: event.stage,
            current: event.progress.current,
            total: event.progress.total,
            remain: event.progress.remain,
            detectedCount: event.detectedCount,
        };
    }

    return {
        phase: "rec",
        stage: event.stage,
        current: event.progress.current,
        total: event.progress.total,
        remain: event.progress.remain,
        latestItem: event.result ? normalizeRecognitionResult(event.result) : undefined,
    };
};

const postProgress = (id: string, type: string, progress: OcrProgressSnapshot) => {
    postMessage({
        id,
        type,
        data: {
            progress,
        } satisfies OcrWorkerData,
    });
};

const createImageInput = (bitmap: ImageBitmap, debugStages?: boolean) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
        throw new Error("Unable to create OCR input canvas");
    }

    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const stages = debugStages
        ? [{
            label: "input",
            dataUrl: "",
            width: bitmap.width,
            height: bitmap.height,
        } satisfies OcrDebugStage]
        : [];

    return {
        input: {
            width: imageData.width,
            height: imageData.height,
            data: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength),
        },
        stages,
        canvas,
    };
};

const fillDebugStageDataUrls = async (stages: OcrDebugStage[], canvas: OffscreenCanvas) => {
    if (!stages.length) {
        return stages;
    }

    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("Unable to serialize OCR debug image"));
        reader.readAsDataURL(blob);
    });

    return stages.map((stage) => ({ ...stage, dataUrl }));
};

/**
 * 逐框重跑 rec，只为拿到 CTC logits。
 *
 * paddleocr 的 recognize() 只回传解码后的文本，而词表纠错必须比较
 * 「不同候选词在真实 logits 上的对齐分」，所以这里复用它暴露的
 * detectionService / recognitionSession 自己走一遍推理。
 * 预处理参数与 paddleocr 默认值保持一致（高 48、最小宽 320、rgb、127.5 归一化）。
 */
const collectRecognitionLogits = async (input: Parameters<typeof normalizeInputToRgb>[0]) => {
    const session = paddleOcrService.recognitionSession;
    const detectionService = paddleOcrService.detectionService;
    if (!session || !detectionService || !lexiconClasses.size) return null;
    const inputName = session.inputNames?.[0];
    const outputName = session.outputNames?.[0] ?? Object.keys(session.outputNames ?? {})[0];
    if (!inputName || !outputName) return null;

    const image = normalizeInputToRgb(input);
    const boxes = await detectionService.run(image, {
        minimumAreaThreshold: 40,
        maxSideLimit: DET_MAX_SIDE_LIMIT,
    });
    if (!boxes.length) return null;

    // 与 PaddleOCR 一致：整批按最大宽高比补齐宽度，短文本不会被拉伸
    let maxRatio = REC_MIN_WIDTH / REC_HEIGHT;
    for (const box of boxes) {
        maxRatio = Math.max(maxRatio, box.width / box.height);
    }
    const targetWidth = Math.max(REC_MIN_WIDTH, Math.ceil(REC_HEIGHT * maxRatio));

    const results: {
        box: { x: number; y: number; width: number; height: number };
        logits: Float32Array;
        sequenceLength: number;
        numClasses: number;
    }[] = [];
    for (const box of boxes) {
        // 窄条框是图标噪点，既纠正不出结果也不该参与纠错，直接跳过省一次推理
        if (isSkillNoiseBox(box)) continue;
        const crop = box.points ? image.cropRotated(box.points) : image.crop(box);
        const proportionalWidth = Math.ceil(REC_HEIGHT * (crop.width / crop.height));
        const resizedWidth = Math.min(proportionalWidth, targetWidth);
        const resized = crop.resize({ width: resizedWidth, height: REC_HEIGHT });
        const tensorData = resized.tensor({
            mean_values: REC_MEAN,
            norm_values: REC_STD,
            channel_order: "rgb",
        });
        const padded = new Float32Array(3 * REC_HEIGHT * targetWidth);
        for (let channel = 0; channel < 3; channel++) {
            for (let y = 0; y < REC_HEIGHT; y++) {
                const sourceStart = channel * REC_HEIGHT * resizedWidth + y * resizedWidth;
                const targetStart = channel * REC_HEIGHT * targetWidth + y * targetWidth;
                padded.set(tensorData.subarray(sourceStart, sourceStart + resizedWidth), targetStart);
            }
        }
        const tensor = new ort.Tensor("float32", padded, [1, 3, REC_HEIGHT, targetWidth]);
        const output = await session.run({ [inputName]: tensor });
        const outputTensor = output[outputName];
        const [, sequenceLength, numClasses] = outputTensor.dims as number[];
        results.push({
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      logits: outputTensor.data as Float32Array,
      sequenceLength,
      numClasses,
    });
    }
    return results;
};

/**
 * 用词表对每行结果做一次纠错，仅在候选明显更优时替换。
 *
 * 按 box 坐标与 logits 对齐，而不是按下标——recognize() 会丢掉识别为空的框，
 * 下标并不保证与 detect 输出一致，按坐标匹配才不会张冠李戴。
 */
const applyLexiconRescore = (items: OcrResultItem[], logitsList: Awaited<ReturnType<typeof collectRecognitionLogits>>) => {
    if (!logitsList?.length || !lexiconClasses.size) return items;

    const byBox = new Map<string, (typeof logitsList)[number]>();
    for (const entry of logitsList) byBox.set(boxKeyOf(entry.box), entry);

    return items.map((item) => {
        const entry = byBox.get(boxKeyOfItem(item));
        if (!entry) return item;
        const candidates = pickLexiconCandidates(item.text, lexiconClasses.keys(), distance);
        if (!candidates.length) return item;
        const { logits, sequenceLength, numClasses } = entry;
        const maxLogits = computeFrameMaxLogits(logits, sequenceLength, numClasses);
        const result = rescoreWithLexicon(
            logits,
            sequenceLength,
            numClasses,
            lexiconClasses,
            item.text,
            candidates,
            maxLogits
        );
        return result.text === item.text ? item : { ...item, text: result.text };
    });
};

// biome-ignore lint/suspicious/noGlobalAssign: worker就是这么写的
onmessage = async (event) => {
    const { data } = event;
    const { type, id } = data;
    if (type === "init") {
        // 初始化OCR服务
        try {
            console.time("OCR服务初始化");
            const det_onnx_buffer = await fetch(det_onnx_url).then((res) => res.arrayBuffer());
            const rec_onnx_buffer = await fetch(rec_onnx_url).then((res) => res.arrayBuffer());
            ppocr_dict_string = await fetch(ppocr_dict_url)
                .then((res) => res.text())
                .then((text) => text.split("\n").map((char) => char.trim()));
            paddleOcrService = await PaddleOcrService.createInstance({
                ort: ort as unknown as OrtModule,
                modelPreset: "PP-OCRv6_small",
                detection: {
                    modelBuffer: det_onnx_buffer,
                },
                recognition: {
                    modelBuffer: rec_onnx_buffer,
                    charactersDictionary: ppocr_dict_string,
                },
            });
            postMessage({ type: "init", data: { result: "success" } });
            console.timeEnd("OCR服务初始化");
        } catch (e) {
            postMessage({ type: "init", data: { error: e } });
        }
    } else if (data.type === "lexicon") {
        // 技能词表在游戏数据到位后再发：init 阶段还拿不到技能名
        try {
            const { words } = data as OcrLexiconInput;
            lexiconClasses = prepareLexicon(words, ppocr_dict_string);
            postMessage({ type: "lexicon", data: { result: "success" } });
        } catch (e) {
            postMessage({ type: "lexicon", data: { error: e } });
        }
    } else if (data.type === "skill") {
        console.time(`OCR服务识别技能图片-${id}`);
        try {
            const { bitmap, options } = data as OcrInput;
            postMessage({ id, type: "skill", data: { msg: "图片读取成功~" } satisfies OcrWorkerData });
            const { input, stages, canvas } = createImageInput(bitmap, options?.debugStages);

            if (stages.length) {
                postMessage({
                    id,
                    type: "skill",
                    data: {
                        debugStages: await fillDebugStageDataUrls(stages, canvas),
                    } satisfies OcrWorkerData,
                });
            }

            postMessage({ id, type: "skill", data: { msg: "OCR处理中~" } satisfies OcrWorkerData });
            const ocrResult = await paddleOcrService.recognize(
                input,
                {
detection: {
                    minimumAreaThreshold: 40,
                    maxSideLimit: DET_MAX_SIDE_LIMIT,
                },
                    charWhiteList: options?.charWhiteList,
                    onProgress: (progressEvent) => {
                        postProgress(id, type, toProgressSnapshot(progressEvent));
                    },
                }
            );
            const normalizedResult: OcrResultItem[] = ocrResult.map(normalizeRecognitionResult);

            // 词表纠错：拿 logits 重跑一遍 rec，只在候选明显更优时替换。
            // 失败不影响主流程，直接用原始结果。
let finalResult = normalizedResult;
            if (options?.lexiconRescore) {
      try {
     postMessage({ id, type: "skill", data: { msg: "词表校正中~" } satisfies OcrWorkerData });
        const logitsList = await collectRecognitionLogits(input);
  finalResult = applyLexiconRescore(normalizedResult, logitsList);
                } catch (e) {
           console.warn("词表校正失败，回退到原始识别结果", e);
         }
            }

    // 丢掉技能图标被框出的窄条噪点：它们只会产出「金/城/元」这类单字，
    // 既拖慢后处理，也可能被模糊匹配拉进技能表
    finalResult = finalResult.filter((item) => !isSkillNoiseBox({ width: item.box[2] }));

            postMessage({ id, type: "skill", data: { msg: "OCR结果已返回" } satisfies OcrWorkerData });
            postMessage({ id, type: "skill", data: { result: finalResult } satisfies OcrWorkerData });
        } catch (error) {
            postMessage({ id, type: "skill", data: { error } satisfies OcrWorkerData });
        } finally {
            console.timeEnd(`OCR服务识别技能图片-${id}`);
        }
    }
};
