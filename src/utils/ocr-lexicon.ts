/**
 * 词典辅助的 OCR 结果纠错。
 *
 * 背景：技能名是固定词表（线上 156 个）。PaddleOCR 自带的 charWhiteList 是在
 * argmax 之后把白名单外的字直接丢弃，这会主动制造错字——例如「一闪无痕」
 * 因首字被误判成杂字而丢字，剩下「闪无痕」。
 *
 * 这里不做硬约束（实测 CTC prefix beam search 限制在词典内会把准确率从
 * 95.8% 打到 50.8%，因为 beam 会吸附到词表高频词并凭空造词），
 * 而是让 OCR 把每行的 CTC logits 带回来，再用词表做一次强制对齐打分，
 * 只有候选明显优于原始结果时才替换。
 *
 * 实测（demo 三张截图）：7 次替换全部为正确修正，零误伤。
 */

/** 预编译词表：词 -> 每个字在模型输出里的 class 下标 */
export const prepareLexicon = (words: string[], dictionary: string[]) => {
    // 模型输出 index 0 是 CTC blank，字典整体右移一位
    const charClass = new Map<string, number>();
    for (let i = 0; i < dictionary.length; i++) charClass.set(dictionary[i], i + 1);

    const entries = new Map<string, number[]>();
    for (const word of words) {
        const classes: number[] = [];
        for (const ch of word) {
            const idx = charClass.get(ch);
            // 词表里有字但模型字典没有，这词无法对齐，直接跳过
            if (idx === undefined) break;
            classes.push(idx);
        }
        if (classes.length === word.length) entries.set(word, classes);
    }
    return entries;
};

/** 预先算好每帧最大 logit，避免候选循环里反复扫全类目 */
export const computeFrameMaxLogits = (logits: Float32Array, sequenceLength: number, numClasses: number) => {
    const maxLogits = new Float32Array(sequenceLength);
    for (let t = 0; t < sequenceLength; t++) {
        const offset = t * numClasses;
        let max = -Infinity;
        for (let i = 0; i < numClasses; i++) {
            const value = logits[offset + i];
            if (value > max) max = value;
        }
        maxLogits[t] = max;
    }
    return maxLogits;
};

/**
 * 单词的 CTC 强制对齐得分（词级平均 log 概率）。
 *
 * Viterbi 在 (帧数 × 词长) 上求最优路径：blank 可任意插入；
 * 相同字符连续输出时中间必须隔一个 blank（标准 CTC 折叠规则）。
 * 用平均值而非总和对齐分，因为总分会系统性偏向短词。
 */
export const scoreAlignment = (
    logits: Float32Array,
    sequenceLength: number,
    numClasses: number,
    classes: number[],
    maxLogits: Float32Array
) => {
    const length = classes.length;
    if (!length || length > sequenceLength) return -Infinity;

    // blank：上一帧输出 blank；charState：上一帧输出字符
    let blankState = new Float32Array(length + 1).fill(-Infinity);
    let charState = new Float32Array(length + 1).fill(-Infinity);
    blankState[0] = 0;

    for (let t = 0; t < sequenceLength; t++) {
        const offset = t * numClasses;
        const blankLogit = logits[offset] - maxLogits[t];
        const nextBlank = new Float32Array(length + 1).fill(-Infinity);
        const nextChar = new Float32Array(length + 1).fill(-Infinity);

        for (let j = 0; j <= length; j++) {
            const previous = blankState[j] > charState[j] ? blankState[j] : charState[j];
            if (previous > -Infinity) nextBlank[j] = previous + blankLogit;
            if (j === 0) continue;

            const charLogit = logits[offset + classes[j - 1]] - maxLogits[t];
            // 上一帧是 blank，可以直接接字符
            if (blankState[j - 1] > -Infinity) {
                const value = blankState[j - 1] + charLogit;
                if (value > nextChar[j]) nextChar[j] = value;
            }
            // 上一帧是字符：与本字不同才能不隔 blank 连着输出
            if (charState[j - 1] > -Infinity && classes[j - 1] !== classes[j - 2]) {
                const value = charState[j - 1] + charLogit;
                if (value > nextChar[j]) nextChar[j] = value;
            }
        }
        blankState = nextBlank;
        charState = nextChar;
    }

    const total = blankState[length] > charState[length] ? blankState[length] : charState[length];
    return total === -Infinity ? -Infinity : total / length;
};

export interface LexiconRescoreOptions {
    /** 候选需比原始结果高出的平均 log 分，抑制噪声抖动 */
    margin?: number;
    /** 候选绝对分数下限，挡掉「框里本来就没这个词」的情况 */
    minScore?: number;
    /** 候选与原始结果的长度差上限 */
    maxLengthDelta?: number;
}

/**
 * 用词表纠正单个文本框的识别结果。
 *
 * 三道闸门缺一不可（都是实测踩出来的）：
 *  - 长度门槛：否则单字框会被硬拉成两字词
 *  - 相对门槛 margin：否则轻微噪声就会触发替换
 *  - 绝对门槛 minScore：只写了一帧的框也能对齐出高分，必须单独挡掉
 */
export const rescoreWithLexicon = (
    logits: Float32Array,
    sequenceLength: number,
    numClasses: number,
    lexiconClasses: Map<string, number[]>,
    originalText: string,
    candidates: string[],
    maxLogits: Float32Array,
    options: LexiconRescoreOptions = {}
) => {
    const { margin = 0.3, minScore = -3, maxLengthDelta = 1 } = options;

    const originalClasses = originalText ? lexiconClasses.get(originalText) : null;
    const originalScore = originalClasses
        ? scoreAlignment(logits, sequenceLength, numClasses, originalClasses, maxLogits)
        : -Infinity;
    const originalLength = originalText ? originalText.length : 0;

    let bestText = originalText;
    let bestScore = originalScore;

    for (const candidate of candidates) {
        if (candidate === originalText) continue;
        if (Math.abs(candidate.length - originalLength) > maxLengthDelta) continue;
        const classes = lexiconClasses.get(candidate);
        if (!classes) continue;
        const score = scoreAlignment(logits, sequenceLength, numClasses, classes, maxLogits);
        if (score < minScore) continue;
        if (score > bestScore + margin) {
            bestScore = score;
            bestText = candidate;
        }
    }

    return { text: bestText, score: bestScore };
};

/**
 * 候选筛选：只保留「编辑距离 ≤ 1」或「长度相近且互相包含」的词。
 * 与 store/game.ts 里 getSkillsFromOcrResult 的思路一致，
 * 但阈值更紧——这里只做纠错，不做模糊匹配，宁可漏候选也不引入错字。
 */
export const pickLexiconCandidates = (text: string, lexicon: Iterable<string>, distance: (a: string, b: string) => number) => {
    if (!text) return [];
    const result: string[] = [];
    for (const word of lexicon) {
        if (word === text) continue;
        if (distance(text, word) <= 1) {
            result.push(word);
            continue;
        }
        if (Math.abs(word.length - text.length) <= 1 && (text.includes(word) || word.includes(text))) {
            result.push(word);
        }
    }
    return result;
};