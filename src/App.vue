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
                                       v-for="(chromeWindow, windowIndex) in lists">
                        </chrome-window>
                    </div>
                </div>
            </el-main>
            <el-footer>Footer</el-footer>
        </el-container>
    </el-container>

</template>
<script>
    import tab_storage from './common/tab_storage'
    import browser from 'webextension-polyfill'
    import {getAllTabs, getAllWindows} from "./common/tab_manager";
    import {getDomainName, getDomainNameFromFullURL} from "./common/url_utils"
    import {activateTab, activateWindow} from "./common/navigation";
    import {transformWindowList} from "./common/ds_transformer";
    import {applySort, TabDomainSorter, TabTitleSorter} from "./common/sort";

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
                    list.key = list.id;
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
                const lists = await getAllTabs();
                const tabs = [];
                for (let list of lists) {
                    tabs.push(...list.tabs);
                }
                const domainWindows = {};
                tabs.sort((x, y) => {
                    let xURL = new URL(x.url);
                    let yURL = new URL(y.url);
                    let xDomain = getDomainName(xURL.hostname);
                    let yDomain = getDomainName(yURL.hostname);
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
                        domainWindows[domain] = {
                            tabs: [],
                            id: 1,
                            key: domain,
                            title: domain + " (Merged Window)",
                        }
                    }
                    domainWindows[domain].tabs.push(tab);
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

