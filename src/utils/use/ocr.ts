import OcrWorker from "@/utils/ocr.worker?worker";
import { nanoid } from "nanoid";

type Handler = (type: string, data: any) => void;

let handlers = new Map<string, Handler>();
let ocrWorker: Worker | null = null;
let queue: [(value: unknown) => void, (reason?: any) => void][] = [];
let initializing = false;

const recognize = (
    type: string,
    bitmap: ImageBitmap,
    options: OcrInputOptions,
    handler: Handler
) => {
    const id = nanoid();
    ocrWorker!.postMessage({ id, type, bitmap, options } as OcrInput, [bitmap]);
    handlers.set(id, handler);
};

/**
 * 把技能词表推给 worker，用于识别后的强制对齐纠错。
 * 词表会变（线上技能数据每 6 小时刷新），所以每次都重发而不是只在 init 发一次。
 */
const setLexicon = (words: string[]) => {
    ocrWorker?.postMessage({ type: "lexicon", words } as OcrLexiconInput);
};

export const useOcrService = async (): Promise<{
    recognize: typeof recognize;
    setLexicon: typeof setLexicon;
}> => {
    // 正在初始化
    if (initializing) {
        await new Promise((resolve, reject) => {
            queue.push([resolve, reject]);
        });
        return { recognize, setLexicon };
    }
    // 第一次调用
    if (!ocrWorker && !initializing) {
        ocrWorker = new OcrWorker();
        ocrWorker.onmessage = (event: MessageEvent) => {
            const { id, type, data } = event.data;
            if (type == "init") {
                initializing = false;
                if (data.result) {
                    queue.forEach(([resolve]) => {
                        resolve(true);
                    });
                    queue = [];
                } else if (data.error) {
                    ocrWorker = null;
                    queue.forEach(([, reject]) => {
                        reject(data.error);
                    });
                    queue = [];
                }
            } else if (type == "lexicon") {
                // 词表是 fire-and-forget，失败时 worker 会退回原始识别结果
            } else {
                const handler = handlers.get(id)!;
                handler(type, data);
                if (data?.result || data?.error) {
                    handlers.delete(id);
                }
            }
        };
        ocrWorker.postMessage({ type: "init" });
        await new Promise((resolve, reject) => {
            queue.push([resolve, reject]);
        });
    }
    return { recognize, setLexicon };
};
