<template>
    <el-container>
        <el-aside width="200px">Aside</el-aside>
        <el-container>
            <el-header>Header</el-header>
            <el-main>
                <div id="app">
                    <div class="toolbar">
                        <span class="btn" v-on:click="sortByDomainEachWindow()">sortByDomain(EachWindow)</span>
                        <span class="btn" v-on:click="sortByDomainMergeWindow()">sortByDomain(MergeWindow)</span>
                        <span class="btn" v-on:click="sortByTitleEachWindow()">sortByTitle(EachWindow)</span>
                        <span class="btn" v-on:click="sortByTitleMergeWindow()">sortByTitle(MergeWindow)</span>
                    </div>
                    <div class="container">
                        <chrome-window v-bind:chrome-window=chromeWindow v-bind:key="chromeWindow.vue_key"
                                       v-bind:chrome-title="chromeWindow.title"
                                       v-bind:chrome-window-index="windowIndex"
                                       v-bind:window-list="lists"
                                       v-for="(chromeWindow, windowIndex) in lists">
                        </chrome-window>
                    </div>
                </div>
            </el-main>
            <el-footer>Footer</el-footer>
        </el-container>
    </el-container>

</template>
<script lang="ts">
    import tab_storage from './common/tab_storage'
    import browser from 'webextension-polyfill'
    import {getAllTabs} from "./common/tab_manager";
    import {getDomainNameFromFullURL} from "./common/url_utils"
    import {activateTab, activateWindow} from "./common/navigation";
    import {transformWindowList} from "./common/ds_transformer";
    import {applySort, TabDomainSorter, TabTitleSorter} from "./common/sort";
    import {NesoiTab, NesoiWindow} from "./common/ds";

    export default {
        data() {
            return {
                lists: [],
                asc_state: true,
            }
        },
        created() {
            this.init();
        },
        watch: {
            // 'lists': 'storeLists',
        },
        methods: {
            activateTab(tab, tabId, windowId, e) {
                if (e) {
                    e.preventDefault(); // 避免打开新标签页
                }
                activateTab(tabId, windowId);
            },
            activateWindow(windowId) {
                activateWindow(windowId);
            },
            async init() {
                const lists = transformWindowList(await getAllTabs());

                for (let list of lists) {
                    list.vue_key = list.id;
                }
                this.lists = lists;
            },
            async sortByDomainEachWindow() {
                const lists = transformWindowList(await getAllTabs());
                applySort(lists, new TabDomainSorter(), {
                    order: this.asc_state ? "asc" : "desc",
                });
                this.asc_state = !this.asc_state;
                this.lists = lists;
            },
            async sortByDomainMergeWindow() {
                const lists: NesoiWindow[] = await getAllTabs();
                const tabs: NesoiTab[] = [];
                for (let list of lists) {
                    tabs.push(...list.tabs);
                }
                const winMap: {
                    [id: number]: NesoiWindow,
                } = {};
                for (let win of lists) {
                    win.tabs = [];
                    winMap[win.id] = win;
                }
                const domainWindows: {
                    [domain: string]: NesoiWindow
                } = {};
                tabs.sort((x, y) => {
                    let xDomain = getDomainNameFromFullURL(x.url);
                    let yDomain = getDomainNameFromFullURL(y.url);
                    if (xDomain < yDomain) {
                        return -1;
                    }
                    if (xDomain > yDomain) {
                        return 1;
                    }
                    return 0;
                });
                for (let tab of tabs) {
                    const domain = getDomainNameFromFullURL(tab.url);
                    if (!domainWindows[domain]) {
                        domainWindows[domain] = JSON.parse(JSON.stringify(winMap[tab.windowId]));
                        domainWindows[domain].id = undefined;
                        domainWindows[domain].vue_key = domain;
                        domainWindows[domain].title = domain + " (Merged Window)";
                        domainWindows[domain].windows = {};
                    }
                    if (!domainWindows[domain].windows[tab.windowId]) {
                        domainWindows[domain].windows[tab.windowId] = JSON.parse(JSON.stringify(winMap[tab.windowId]));
                    }
                    domainWindows[domain].windows[tab.windowId].tabs.push(tab);
                }
                this.lists = Object.values(domainWindows);
            },
            async sortByTitleEachWindow() {
                const lists = transformWindowList(await getAllTabs());
                applySort(lists, new TabTitleSorter(), {
                    order: this.asc_state ? "asc" : "desc",
                    reverse_title: false,
                });
                this.asc_state = !this.asc_state;
                this.lists = lists;
            },
            async sortByTitleMergeWindow() {

            },
        }
    }
</script>
<style>
    body {
        font-size: 0.85em;
        margin: 0;
    }

    .title {
        display: inline-block;
        padding: 0 32px;
    }

    .btn {
        display: inline-block;
        padding: 4px 8px;
        cursor: pointer;
    }

    .btn:hover {
        text-decoration: underline;
        user-select: none;
    }

    .container {
        max-width: 680px;
        margin: 0 auto;
        border: 0;
    }

    .el-header, .el-footer {
        color: #333;
        text-align: center;
        line-height: 60px;
        background: aquamarine;

    }

    .el-aside {
        color: #333;
        text-align: center;
        line-height: 200px;
        background: antiquewhite;
    }

    .el-main {
        color: #333;
        text-align: center;
        line-height: 160px;
        background: aqua;

    }

    body > .el-container {
        /*margin-bottom: 40px;*/
    }

    .el-container:nth-child(5) .el-aside,
    .el-container:nth-child(6) .el-aside {
        line-height: 260px;
    }

    .el-container:nth-child(7) .el-aside {
        line-height: 320px;
    }
</style>

