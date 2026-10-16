interface ResponsePagedData<T = any> {
    code: number;
    msg: string;
    data: {
        list: T[];
        total: number;
    };
}

interface ResponseData<T = any> {
    code: number;
    msg: string;
    data: T[];
}

interface OcrResultItem {
    text: string;
    confidence: number;
    box: number[];
}

type OcrProgressPhase = "preprocess" | "det" | "rec";

interface OcrProgressSnapshot {
    phase: OcrProgressPhase;
    stage: string;
    current: number;
    total: number;
    remain: number;
    detectedCount?: number;
    latestItem?: OcrResultItem;
}

interface OcrProgressState {
    preprocess?: OcrProgressSnapshot;
    detection?: OcrProgressSnapshot;
    recognition?: OcrProgressSnapshot;
    detectedCount?: number;
    latestText?: string;
}

interface OcrDebugTransform {
    offsetX: number;
    offsetY: number;
    sourceWidth: number;
    sourceHeight: number;
}

interface OcrDebugStage {
    label: string;
    dataUrl: string;
    width: number;
    height: number;
    meta?: Record<string, number>;
    transform?: OcrDebugTransform;
}

interface OcrInput {
    id: string;
    type: "skill" | "item";
    bitmap: ImageBitmap;
    options?: OcrInputOptions;
}

interface OcrInputOptions {
charWhiteList?: string[];
    debugStages?: boolean;
    /** 是否启用词表纠错（技能识别用；仓库识别的文本不在技能词表内） */
    lexiconRescore?: boolean;
}

interface OcrLexiconInput {
id?: string;
type: "lexicon";
    /** 技能名 + 等级标签，worker 内编译成强制对齐用的 class 序列 */
    words: string[];
}

interface OcrWorkerData {
    error?: unknown;
    msg?: string;
    result?: OcrResultItem[];
    debugStages?: OcrDebugStage[];
    progress?: OcrProgressSnapshot;
}
