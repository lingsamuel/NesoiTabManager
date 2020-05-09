<template>
    <div class="window-container">
        <div class="window-header">
            <input type="checkbox"/>
            <img src="https://img.icons8.com/color/24/000000/chrome--v1.png"/>
            <div v-if="typeof chromeWindow.id === 'number'"
                 class="window-title">
                <a class="nesoi-link" v-bind:href="'chrome://windows/'+chromeWindow.id"
                   v-on:click="activateWindow(chromeWindow.id)">
                    {{ chromeWindow.title }} | {{ getWindowDescription(chromeWindow) }}</a>
                <span class="title">{{ chromeWindow.title }}</span>
            </div>
            <div v-else
                 class="window-title">
                <span class="title">{{ chromeWindow.title }} | {{ getWindowDescription(chromeWindow) }}</span>
            </div>
            <div class="window-operation-list">
                <span v-if="typeof chromeWindow.id === 'number' && !isSub" class="window-tab-btn"
                      v-on:click="closeWindow(chromeWindow.id, chromeWindowIndex)">X</span>
                <span v-if="typeof chromeWindow.id === 'number' && isSub" class="window-tab-btn"
                      v-on:click="closeSubWindow(chromeWindow.tabs, chromeWindow.id)">X</span>
            </div>
        </div>
        <div v-if="chromeWindow.tabs && chromeWindow.tabs.length > 0" class="window-tab-list">
            <ul>
                <li v-for="(tab, tabIndex) in chromeWindow.tabs" draggable="true">
                    <div class="tab-entry">
                        <input type="checkbox"/>
                        <img class="tab-icon" v-if="tab && tab.favIconUrl" :src="tab.favIconUrl"
                             alt="FavIcon"/>
                        <a class="tab-title" :href="tab.url" target="_blank"
                           v-on:click="activateTab(tab, tab.id, tab.windowId, $event)">
                            {{ tab.title }}</a>
                        <span class="window-tab-btn" v-on:click="closeTab(tab.id, tabIndex)">X</span>
                    </div>
                </li>
            </ul>
        </div>
        <chrome-window v-bind:chrome-window=subWin
                       v-bind:chrome-window-index="subWindowIndex"
                       v-bind:is-sub=true
                       v-bind:window-list="chromeWindow.windows"
                       v-bind:key="subWin.vue_key"
                       v-if="chromeWindow.windows" v-for="(subWin, subWindowIndex) in chromeWindow.windows">
        </chrome-window>
    </div>
</template>
<script lang="ts">
    import {activateTab, activateWindow} from "../common/navigation";
    import {closeTab, closeWindow, getTabsByWindow} from "../common/tab_manager";
    import {NesoiTab, NesoiWindow} from "../common/ds";
    import Vue from "vue";

    export default {
        // data() {
        //     return {
        //         chromeWindow: {},
        //     }
        // },
        props: ["chromeWindow", "isSub", "chromeWindowIndex", "windowList"],
        created() {
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
            closeWindow(tabId, winIndex) {
                this.windowList.splice(winIndex, 1);
                closeWindow(tabId);
            },
            closeTab(tabId, tabIndex) {
                this.chromeWindow.tabs.splice(tabIndex, 1);
                closeTab(tabId);
            },
            async closeSubWindow(tabs: NesoiTab[], windowId) {
                const win = await getTabsByWindow(windowId);
                const tabIds = tabs.map(x => x.id);
                // 是否是整个窗口
                if (win.tabs.length === tabs.length) {
                    const winTabIds = win.tabs.map(t => t.id);
                    let match = true;
                    for (let id of tabIds) {
                        if (!winTabIds.includes(id)) {
                            match = false;
                        }
                    }
                    if (match) {
                        // TODO 需要一直上溯
                        Vue.delete(this.windowList, windowId);
                        closeWindow(windowId); // 使用 closeWindow，可以让 Ctrl-Shift-T 打开一整组标签页
                    } else {
                        Vue.delete(this.windowList, windowId);
                        closeTab(tabIds);
                    }
                } else {
                    Vue.delete(this.windowList, windowId);
                    closeTab(tabIds);
                }

            },
            getWindowDescription(win: NesoiWindow) {
                if (win.tabs && win.tabs.length && win.tabs.length > 0) {
                    return win.tabs.length + " tab(s)";
                } else if (win.windows && typeof win.windows === "object") {
                    const winArray = Object.values(win.windows);
                    if (winArray.length > 0) {
                        return winArray.length + " sub window(s)";
                    }
                }
                return "UNKNOWN_LENGTH_ERROR"
            }
        }
    }
</script>
<style>
    .title {
        display: inline-block;
        /*padding: 0 32px;*/
    }

    .window-header {
        line-height: 50px;
        background: rgb(240, 240, 240);
    }

    .container .tab-icon {
        border-radius: 0;
    }

    .tab-entry .nesoi-center {
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .nesoi-link {
        margin-right: 10px;
        /*width: 100%;*/
        text-decoration: none;
        color: black;

        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .nesoi-link:hover {
        text-decoration: underline;
    }

    .tab-entry {
        display: flex;
        flex-direction: row;
        align-items: center;
        -webkit-padding-start: 12px;
        -webkit-padding-end: 12px;
    }

    .window-tab-list li:nth-child(odd) {
        background-color: white;
    }

    .window-tab-list li:nth-child(even) {
        background-color: #f5f5f5;
    }

    .tab-entry .tab-title {
        margin-right: 10px;
        width: 100%;
        text-decoration: none;
        color: black;

        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tab-entry .tab-title:hover {
        text-decoration: underline;
    }

    .window-container {
        /*display: flex;*/
        margin: 26px 0;
        /*border-width: thin;*/
        /*border-style: solid;*/
    }

    .window-container .window-container {
        margin: 8px 0 8px 12px;
    }

    .window-container .window-container .window-header {
        line-height: 30px;
        background: #eeefff;
    }

    .window-container .window-tab-list {
        text-align: left;
        border: 1px solid #d1d5da;
        border-top: none;
    }

    .window-container .window-tab-list ul {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .window-container .window-tab-list ul li {
        line-height: 32px;
    }

    .window-container .window-tab-list ul li img {
        width: 16px;
        height: 16px;
        padding: 8px;
    }

    .window-container .window-tab-list ul li a {
        text-decoration: none;
        color: black;
        /*position: absolute;*/
    }

    .window-container .window-tab-list ul li a:hover {
        color: black;
        /*position: absolute;*/
    }

    .window-container .window-tab-list .window-tab-btn {
        padding: 5px;
        cursor: pointer;
    }

    .window-container .window-tab-list .window-tab-btn:hover {
        text-decoration: underline;
    }

    .window-container .window-header {
        align-items: center;
        display: flex;
        min-height: 2.8em;
        border: 1px solid rgba(27, 31, 35, 0.15);
        border-top-left-radius: 3px;
        border-top-right-radius: 3px;

        -webkit-padding-start: 12px;
        -webkit-padding-end: 12px;
        -moz-padding-start: 12px;
        -moz-padding-end: 12px;
        font-size: 0.85em;
        /*color: whitesmoke;*/
    }

    .window-container .window-header .window-title {
        width: 100%;
        padding: 0 16px;
        text-align: left;
    }

    .window-container .window-header .window-operation-list .window-tab-btn {
        padding: 5px;
        cursor: pointer;
    }

    .window-container .window-header .window-operation-list .window-tab-btn:hover {
        text-decoration: underline;
    }

</style>
