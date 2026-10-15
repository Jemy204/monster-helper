<template>
    <n-config-provider :theme="currentTheme" :locale="zhCN" :inline-theme-disabled="true">
        <n-global-style />
        <n-message-provider>
            <n-notification-provider>
                <n-dialog-provider>
                    <main class="c-layout" :style="appThemeStyle">
                        <SideBar />
                        <div class="c-container">
                            <!--
                                统计/首领/提升三页保留组件实例，切走再回来时筛选、排序、
                                已选角色等状态不丢。用 route.meta.keepAlive 作为 key，
                                否则不同路由会复用同一个缓存实例导致页面错乱。
                            -->
                            <router-view v-slot="{ Component, route }">
                                <keep-alive :include="cachedViews">
                                    <component :is="Component" :key="route.meta.keepAlive ? route.name : undefined" />
                                </keep-alive>
                            </router-view>
                        </div>
                    </main>
                </n-dialog-provider>
            </n-notification-provider>
        </n-message-provider>
    </n-config-provider>
</template>

<script lang="ts" setup>
import SideBar from "./components/common/SideBar.vue";
import { useGameStore } from "@/store/game";
import { zhCN } from "naive-ui";
import { currentTheme } from "@/utils/theme";
import type { CSSProperties } from "vue";

const appThemeStyle = computed<CSSProperties>(() => ({
    "--m-scrollbar-color": currentTheme.value.common.scrollbarColor,
    "--m-scrollbar-color-hover": currentTheme.value.common.scrollbarColorHover,
} as CSSProperties));

/**
 * 需要保留状态的页面（组件名需与 .vue 文件名一致，keep-alive 按名字匹配）。
 * 这几页都有筛选/选中状态，重新进入时若组件被重建就会丢失。
 */
const cachedViews = ["Stat", "StatBoss", "Improve"];

onMounted(() => {
    const gameStore = useGameStore();
    gameStore.fetchSkills();
    gameStore.fetchBossList();
});
</script>

<style lang="less">
@import "./assets/style/common.less";
@import "./assets/style/app.less";
</style>
<style lang="less" scoped>
.c-layout {
    display: flex;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
}
.c-container {
    padding: 30px;
    box-sizing: border-box;
    flex-grow: 1;
    min-width: 0;
    overflow-y: auto;
    .scrollbar();
}
</style>
