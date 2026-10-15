<template>
    <div class="p-improve">
        <div class="m-toolbar">
            <n-flex :wrap="false" :align="'center'" class="u-selects">
                <n-select
                    v-model:value="selectedAccounts"
                    class="u-account-select"
                    multiple
                    filterable
                    clearable
                    :max-tag-count="1"
                    :max-tag-placeholder="renderAccountOverflowTag"
                    :options="accountOptions"
                    placeholder="选择账号，默认显示全部"
                />
                <role-select
                    v-model:value="selectedRoleIds"
                    class="u-role-select"
                    multiple
                    clearable
                    :max-tag-count="1"
                    :max-tag-placeholder="renderRoleOverflowTag"
                    placeholder="选择角色，默认显示全部"
                />
            </n-flex>
            <n-flex :wrap="false" :align="'center'" class="shrink-0">
                <n-text depth="3">只看有缺口</n-text>
                <n-switch v-model:value="onlyShowGapped" class="u-only-gapped" />
                <n-spin v-if="isLoading" size="small" />
                <n-button type="primary" :loading="isLoading" @click="loadMap(true)">
                    <template #icon>
                        <i-material-symbols:refresh-rounded />
                    </template>
                    刷新本周地图
                </n-button>
            </n-flex>
        </div>

        <div class="m-data" ref="tableWrapperRef">
            <n-empty v-if="!data.length" class="u-empty" :description="emptyText" />
            <n-data-table
                v-else
                class="u-table"
                :max-height="maxHeight"
                :columns="columns"
                :data="data"
                :bordered="true"
                :single-line="false"
                :scroll-x="tableWidth"
                :row-key="(row: BossRow) => row.key"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { h, resolveComponent, shallowRef } from "vue";
import { DataTableColumns } from "naive-ui";
import { useResizeObserver } from "@vueuse/core";
import { useGameStore } from "@/store/game";
import { useRoleStore } from "@/store/role";
import { iconLink, schoolIconLink } from "@/utils/game";
import { noThreeLevelSpiritEnduranceSkills } from "@/assets/data/game";

/** 单元格里的单个技能条目 */
interface GapItem {
    skillId: number;
    name: string;
    icon: number;
    /** 角色当前已拥有的重数；undefined 表示性别相符但完全没学 */
    level: number | undefined;
}

/** 提升列表的一行：某个层号上的首领 */
interface BossRow {
    key: string;
    /** 排序用层号，81-100 取自本周地图，101 为固定首领 */
    floor: number;
    bossName: string;
    /** 固定首领（101）不随每周地图变化 */
    isFixed: boolean;
    /** 门槛重数，81-90 为 9，91-101 为 10 */
    targetLevel: number;
    skills: { id: number; name: string; icon: number; gender: Gender | null }[];
}

/** 固定附加的首领，排在 101，每周不参与地图变动 */
const FIXED_BOSS_NAME = "罗伊客";
const FIXED_FLOOR = 101;

const gameStore = useGameStore();
const roleStore = useRoleStore();

const selectedRoleIds = shallowRef<string[]>([]);
/** 账号多选；与角色多选互斥（见下方 watch），任何时候只有一个生效 */
const selectedAccounts = shallowRef<string[]>([]);
const isLoading = shallowRef(false);

/**
 * 账号与角色互斥：先选账号再选角色则清空账号，反之清空角色。
 * 两者都能表达"哪些角色要展示"，同时生效会产生歧义，所以后选的那个顶掉先选的。
 * 用 immediate:false 保证只在"用户主动改变选择"时触发，
 * 清空动作本身不会反向触发另一方的 watch（值已空，不会再满足条件）。
 */
watch(selectedAccounts, (accounts) => {
    if (accounts.length && selectedRoleIds.value.length) selectedRoleIds.value = [];
});
watch(selectedRoleIds, (roleIds) => {
    if (roleIds.length && selectedAccounts.value.length) selectedAccounts.value = [];
});
/**
 * 只看有缺口：隐藏"所有选中角色都已达标"的行。
 * 注意作用对象是**行**而不是列 —— 需求原话是"所有角色学的技能都大于或等于
 * 当前行BOSS的技能重数"时该行无意义，且与角色多选联动。
 */
const onlyShowGapped = shallowRef(false);

/** 角色在某行是否达标：性别相符的技能全部达到该行门槛（无缺口） */
const isRoleRowGapped = (row: BossRow, role: Role): boolean => {
    const levelMap = roleStore.getSkillLevelMap(role);
    return row.skills.some((skill) => {
        if (!canLearn(skill, role)) return false;
        const level = levelMap.value[skill.id];
        return level === undefined || level < row.targetLevel;
    });
};

/**
 * 账号下拉选项。去重后按 roleStore.accountOrder 排序，没有在order 里的按字典序垫后。
 */
const accountOptions = computed(() => {
    const accountOrder = roleStore.accountOrder || [];
    return Array.from(new Set(roleStore.roles.map((role) => role.account).filter(Boolean)))
        .sort((a, b) => {
            const aIndex = accountOrder.indexOf(a);
            const bIndex = accountOrder.indexOf(b);
            if (aIndex !== -1 || bIndex !== -1) {
                return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
                    (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
            }
            return a.localeCompare(b);
        })
        .map((account) => ({ label: account, value: account }));
});

/**
 * 参与统计的角色。账号与角色互斥（后选的那个顶掉先选的），所以只需判断生效的那个：
 * - 都不选 → 全部角色
 * - 选了账号 → 该账号下所有角色
 * - 选了角色 → 所选角色
 */
const selectedRoles = computed<Role[]>(() => {
    const roles = roleStore.roles;
    if (selectedAccounts.value.length) {
        return roles.filter((role) => selectedAccounts.value.includes(role.account));
    }
    if (!selectedRoleIds.value.length) return roles;
    return selectedRoleIds.value
        .map((roleId) => roleStore.getRoleById(roleId))
        .filter((role): role is Role => Boolean(role));
});

const loadMap = async (force = false) => {
    if (isLoading.value) return;
    isLoading.value = true;
    try {
        // 复用地图页的缓存策略，不会每次进页面都打接口
        await gameStore.fetchWeeklyMonsterMap(force);
    } finally {
        isLoading.value = false;
    }
};

onMounted(() => {
    loadMap();
});

/** 从 monsterBosses 中按名字取首领，失败返回 null */
const findBossByName = (name: string): MonsterBoss | null =>
    gameStore.monsterBosses.find((boss) => boss.name === name) || null;

/**
 * 额外掉落映射：某些首领会附带掉落另一个首领的同阶技能。
 *
 * 方向是单向的 —— 程沐华·青年 会掉 程沐华 的技能，但程沐华 不会掉 程沐华·青年 的。
 * 用接口 szName（首领取到的 boss.name）作 key。
 *
 * 这里没有直接复用 `getBossExtraDrop`：它按 bossList 的 `name` 精确匹配，
 * 而配置里写的是 `程沐华（青年）`/`韦柔丝（困境）`（全角括号），
 * 接口返回的是 `程沐华·青年`/`韦柔丝·困境`（中点），对不上会取不到。
 * 这里显式声明，避免受配置名与接口名差异影响。
 *
 * 范围仅限下面这几个已确认的首领，不作为通用"附带技能"规则：
 * 普通的 belongBoss 反查一律不用，避免把别的主首领技能混进来。
 */
const EXTRA_DROP_SOURCES: Record<string, string[]> = {
    "程沐华·青年": ["程沐华"],
    "韦柔丝·困境": ["韦柔丝"],
    "肖红": ["肖童"],
};

/**
 * 取该首领的技能池名。
 *
 * 恶战系列（恶战日轮山城 / 恶战灵霄峡 等）共用同一批技能 —— 接口里 szSkill 完全一致，
 * 且技能的 szBossName 统一是 "恶战"，store 里 belongBoss 也已归一为 "恶战"。
 * 所以凡首领名含"恶战"都按同一个技能池处理，任一恶战首领都能查到全部恶战技能。
 */
const getSkillPoolName = (bossName: string): string => (bossName.includes("恶战") ? "恶战" : bossName);

/**
 * 取该首领在本层的技能。
 *
 * 以 `boss.szSkill`（首领自己的掉落表）为唯一权威依据，只显示主技能。
 * szSkill 里两种ID 混用（多数 dwOutSkillID，司徒一一/阿依努尔/武雪散/程沐华·青年 等
 * 用 dwInSkillID），所以统一走 getSkillByDropId 双索引查找。
 *
 * 为什么不按 belongBoss 反查：技能的 szBossName 会把多个归属首领合并成一个字符串
 * （顿号分隔，如 "钱宗龙、杜姬欣"），反查会把别的主首领的技能带进来
 * （绝地反击 / 逆波式 / 俯阵熊突 等附带技能就是这么混进来的，它们从不出现在任何 szSkill 里）。
 *
 * 两处例外：
 * 1. szSkill 为空的首领（当前只有罗伊客）回退按 belongBoss 反查，否则该行整个变空；
 * 2. EXTRA_DROP_SOURCES 里显式声明的额外掉落仍然叠加（按需求保留）。
 */
const resolveBossSkills = (boss: MonsterBoss) => {
    const fromDropIds = (boss.skills || [])
        .map((id) => gameStore.getSkillByDropId(id))
        .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
    // 主技能：只认 szSkill；为空时才回退反查（仅罗伊客会走到这）
    const own = fromDropIds.length
        ? fromDropIds
        : gameStore.skills.filter((skill) => skill.belongBoss?.includes(getSkillPoolName(boss.name)));

    const extraNames = EXTRA_DROP_SOURCES[boss.name];
    if (!extraNames?.length) return own;

    const extra = gameStore.skills.filter((skill) =>
        extraNames.some((name) => skill.belongBoss?.includes(name))
    );
    if (!extra.length) return own;

    const seen = new Set(own.map((skill) => skill.id));
    return [...own, ...extra.filter((skill) => !seen.has(skill.id))];
};

/**
 * 剔除附带技能，只保留主技能。
 *
 * 判定与首领页「隐藏附带技能」开关完全一致 —— 都用 noThreeLevelSpiritEnduranceSkills：
 * 逆波式 / 夜叉浮乐 / 铁猬 / 海龙御劲 / 俯阵熊突 / 麒麟遁甲 / 绝地反击。
 * 这批技能学完主技能（如角抵技巧 → 俯阵熊突）就会自动带上，不算真正的缺口，
 * 所以提升页一律不显示，只显示 addonSkillMap 里对应的主技能。
 */
const dropAddonSkills = (skills: MonsterSkill[]) =>
    skills.filter((skill) => !noThreeLevelSpiritEnduranceSkills.has(skill.id));

const buildRow = (key: string, floor: number, boss: MonsterBoss, isFixed: boolean): BossRow => {
    const skills = dropAddonSkills(resolveBossSkills(boss));
    // 技能暂时取不到时仍然保留该行（缺口留空），避免整行从表里消失。
    // 后续技能数据到位后 computed 会自动重算补上。
    return {
        key,
        floor,
        bossName: boss.name,
        isFixed,
        // 91 层起（含固定 101 行）都是 10 重门槛
        targetLevel: floor >= 91 ? 10 : 9,
        skills: skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            icon: skill.icon,
            gender: skill.gender,
        })),
    };
};

/**
 * 行数据 = 本周地图 81-100 层（顺序与名字每周都可能变）+ 固定追加的 101 罗伊客。
 * 81-100 行只依赖本周地图，逐层读取，保证顺序与地图一致。
 */
const rows = computed<BossRow[]>(() => {
    const floors = gameStore.monsterMap?.floors || [];
    const result: BossRow[] = [];

    for (const floor of floors) {
        if (floor.floor < 81 || floor.floor > 100) continue;
        if (!floor.boss) continue;
        const row = buildRow(`floor-${floor.floor}`, floor.floor, floor.boss, false);
        result.push(row);
    }

    const fixedBoss = findBossByName(FIXED_BOSS_NAME);
    if (fixedBoss) {
        result.push(buildRow(`fixed-${FIXED_BOSS_NAME}`, FIXED_FLOOR, fixedBoss, true));
    }

    return result.sort((a, b) => a.floor - b.floor);
});

/** 该技能性别是否允许该角色学习：null 表示通用 */
const canLearn = (skill: MonsterSkill, role: Role) =>
    skill.gender === null || skill.gender === role.gender;

/**
 * 预计算每个角色在每行的缺口。
 * 规则：
 * - 性别不符的技能直接跳过，不算缺口也不标"未学"（该角色根本学不了）
 * - 已拥有但重数低于该行门槛 → 显示"当前重数"
 * - 性别相符但完全没拥有 → 显示"未学"
 * 全部达标的行保留空单元格，保证 81-100 行不缺失。
 */
const gapsByRow = computed(() => {
    const map: Record<string, Record<string, GapItem[]>> = {};
    for (const row of rows.value) {
        map[row.key] = {};
        for (const role of selectedRoles.value) {
            const levelMap = roleStore.getSkillLevelMap(role);
            const gaps: GapItem[] = [];
            for (const skill of row.skills) {
                if (!canLearn(skill, role)) continue;
                const level = levelMap.value[skill.id];
                if (level !== undefined && level >= row.targetLevel) continue;
                gaps.push({
                    skillId: skill.id,
                    name: skill.name,
                    icon: skill.icon,
                    level,
                });
            }
            map[row.key][role.id || role.name] = gaps;
        }
    }
    return map;
});

/**
 * 表格数据。开关关闭时就是全部行（81-100 永不缺失）；
 * 开关打开时，隐藏"所有选中角色都已达标"的行 —— 没选角色就等于没缺口，全部显示。
 */
const data = computed(() => {
    if (!onlyShowGapped.value) return rows.value;
    const roles = selectedRoles.value;
    if (!roles.length) return rows.value;
    return rows.value.filter((row) => roles.some((role) => isRoleRowGapped(row, role)));
});

/** 缺口单元格渲染：无缺口留空，有缺口列出图标 + 重数（或"未学"）+ 技能名 */
const renderGaps = (row: BossRow, role: Role) => {
    const gaps = gapsByRow.value[row.key]?.[role.id || role.name] || [];
    if (!gaps.length) return null;
    return h(
        "div",
        { class: "u-gap-list" },
        gaps.map((item) => {
            const unlearned = item.level === undefined;
            return h(
                "span",
                {
                    class: ["u-gap-item", unlearned ? "is-unlearned" : ""],
                    title: `${unlearned ? "未学" : item.level + "重"} ${item.name}`,
                },
                [
                    h("img", { class: "u-icon", src: iconLink(item.icon), alt: "" }),
                    unlearned
                        ? h("span", { class: "u-level u-level-none" }, { default: () => "未学" })
                        : h("span", { class: "u-level" }, { default: () => String(item.level) }),
                    h("span", { class: "u-name" }, { default: () => item.name }),
                ]
            );
        })
    );
};

const columns = computed<DataTableColumns<BossRow>>(() => {
    const result: DataTableColumns<BossRow> = [
        {
            title: "首领",
            key: "bossName",
            width: bossColumnWidth.value,
            fixed: "left",
            sorter: (a, b) => a.floor - b.floor,
            render: (row) =>
                h("div", { class: "u-boss-cell" }, [
                    h("span", { class: "u-floor" }, { default: () => row.floor }),
                    h(
                        "div",
                        { class: "u-boss-right" },
                        [
                            h("span", { class: "u-boss-name" }, { default: () => row.bossName }),
                            h(
                                "span",
                                { class: ["u-tier", row.targetLevel === 10 ? "tier10" : "tier9"] },
                                { default: () => `${row.targetLevel}重` }
                            ),
                        ]
                    ),
                ]),
        },
    ];

    for (const role of selectedRoles.value) {
        result.push({
            title: () =>
                h("div", { class: "u-role-head" }, [
                    h(
                        resolveComponent("n-image"),
                        {
                            style: { width: "20px", height: "20px", flexShrink: 0 },
                            src: role.schoolId ? schoolIconLink(role.schoolId) : "",
                            previewDisabled: true,
                        }
                    ),
                    h("span", { class: "u-role-name" }, { default: () => role.name || "未命名角色" }),
                ]),
            key: role.id || role.name,
            // 必须用显式 width而不是 minWidth：
            // scroll-x 依赖各列 width 累加撑开表格宽度，minWidth 会让列可收缩，
            // 结果 scroll-x 算出的总宽小于容器宽度，横向滚动条就不出现。
            width: 180,
            resizable: true,
            render: (row) => renderGaps(row, role),
        });
    }

    return result;
});

/**
 * 首领列宽按本周最长的首领名动态计算，保证名字完整显示不被截断。
 * 结构：层号(22) + 间距(8) + 名字(字数×13) + 间距(5) + 重数徽标(34) + 单元格内边距(24)
 */
const bossColumnWidth = computed(() => {
    const longest = rows.value.reduce((max, row) => Math.max(max, row.bossName.length), 0);
    return Math.max(120, longest * 13 + 93);
});

const tableWidth = computed(() => bossColumnWidth.value + selectedRoles.value.length * 180);

/**
 * 给表格设 max-height 让它内部滚动，这样横向滚动条固定在可视区底部，
 * 不用拉到页面最底才能左右拖动（行数多时的核心痛点）。
 * 做法与统计页一致：监听容器高度，减去工具栏占用。
 */
const tableWrapperRef = ref<HTMLElement | null>(null);
const maxHeight = ref(0);
/** 重新按容器实际高度同步，供缓存恢复时调用 */
const syncTableHeight = () => {
    const el = tableWrapperRef.value;
    if (el) maxHeight.value = el.getBoundingClientRect().height;
};
useResizeObserver(tableWrapperRef, (entries) => {
    const entry = entries[0];
    maxHeight.value = entry.contentRect.height;
});
// keep-alive 恢复时容器刚从脱离状态插入 DOM，ResizeObserver 可能已错过那次变化，主动同步一次
onActivated(syncTableHeight);

const renderRoleOverflowTag = () => `+${selectedRoleIds.value.length - 1}`;

const renderAccountOverflowTag = () => `+${selectedAccounts.value.length - 1}`;

const emptyText = computed(() => {
    if (!roleStore.roles.length) return "还没有角色，先到角色页创建";
    if (selectedRoles.value.length === 0) return "请选择角色";
    if (!rows.value.length) return "本周地图尚未加载，点击右上角刷新";
    // 开关打开且所有行都对所选角色无缺口
    if (onlyShowGapped.value) return "所选角色在 81-100 层已全部达标";
    return "";
});
</script>

<style lang="less" scoped>
.p-improve {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    height: 100%;

    .m-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;

        .u-selects {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;

            .u-account-select {
                width: 220px;
            }

            .u-role-select {
                width: 260px;
            }
        }
    }

    .m-data {
        width: 100%;
        // 与统计页保持一致：height:0 + flex-grow 让容器拿到确定高度上限，
        // n-data-table 的 max-height 才会生效，内部滚动时横向滚动条固定在可视区底部。
        // 注意不能加 overflow:hidden，否则会把表格内部滚动容器（含滚动条）裁掉。
        flex-shrink: 0;
        flex-grow: 1;
        height: 0;
    }

    .u-only-gapped {
        margin-right: 8px;
    }

    .u-empty {
        .flex-center;
        min-height: 200px;
    }

    .u-table {
        :deep(.u-role-head) {
            display: flex;
            align-items: center;
            gap: 5px;

            .u-role-name {
                color: var(--n-text-color);
                font-weight: 600;
            }
        }

        :deep(.u-boss-cell) {
            display: flex;
            align-items: center;
            gap: 8px;

            .u-floor {
                min-width: 22px;
                color: var(--n-text-color-3);
                font-size: 12px;
                font-variant-numeric: tabular-nums;
                text-align: center;
            }

            .u-boss-right {
                display: flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
            }

            .u-boss-name {
                color: var(--n-text-color);
                white-space: nowrap;
            }

            .u-tier {
                flex: none;
                padding: 0 4px;
                border-radius: 3px;
                font-size: 11px;
                line-height: 16px;

                &.tier9 {
                    color: var(--n-color-warning);
                    background-color: var(--n-color-warning-suppl);
                }

                &.tier10 {
                    color: var(--n-color-error);
                    background-color: var(--n-color-error-suppl);
                }
            }
        }

        :deep(.u-gap-list) {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            padding: 2px 0;
        }

        :deep(.u-gap-item) {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 1px 5px 1px 2px;
            border: 1px solid var(--n-border-color);
            border-radius: 3px;
            background-color: var(--n-color-modal);
            font-size: 12px;
            line-height: 18px;

            // 完全没学的技能：虚线边框，区分于"已学但重数不够"
            &.is-unlearned {
                border-style: dashed;
                opacity: 0.75;
            }

            .u-icon {
                width: 16px;
                height: 16px;
                flex: none;
                border-radius: 2px;
                object-fit: cover;
            }

            .u-level {
                color: var(--n-color-warning);
                font-weight: 700;
                font-variant-numeric: tabular-nums;

                &.u-level-none {
                    color: var(--n-text-color-3);
                    font-weight: 400;
                }
            }

            .u-name {
                max-width: 96px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
        }
    }
}
</style>