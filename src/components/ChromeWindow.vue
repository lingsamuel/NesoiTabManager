<template>
    <div class="window-container">
        <div class="window-header">
            <input type="checkbox"/>
            <img src="https://img.icons8.com/color/24/000000/chrome--v1.png"/>
            <div class="window-title">
                <a class="nesoi-link" :href="'chrome://windows/'+chromeWindow.id"
                   v-on:click="activateWindow(chromeWindow.id)">
                    Window {{ chromeWindow.id }} | {{ chromeWindow.tabs.length }} tab(s)</a>
                <span class="title">{{ chromeWindow.title }}</span>
            </div>
            <div class="window-operation-list">

            </div>
        </div>
        <div class="window-tab-list">
            <ul>
                <li v-for="(tab, tabIndex) in chromeWindow.tabs" draggable="true">
                    <div class="tab-entry">
                        <input type="checkbox"/>
                        <img class="tab-icon" v-if="tab && tab.favIconUrl" :src="tab.favIconUrl"
                             alt="FavIcon"/>
                        <a class="tab-title" :href="tab.url" target="_blank"
                           v-on:click="activateTab(tab, tab.id, tab.windowId, $event)">
                            {{ tab.title }}</a>
                        <span class="window-tab-btn" v-on:click="closeTab(tab.id)">X</span>
                    </div>
                </li>
            </ul>
        </div>
    </div>
</template>
<script>
    import {activateTab, activateWindow} from "../common/navigation";
    import {closeTab} from "../common/tab_manager";

    export default {
        // data() {
        //     return {
        //         chromeWindow: {},
        //     }
        // },
        props: ["chromeWindow"],
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
            closeTab(tabId) {
                closeTab(tabId);
            }
        }
    }
</script>
<style>
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
        border: 1px solid rgba(27, 31, 35, 0.15);
        border-top-left-radius: 3px;
        border-top-right-radius: 3px;
    }

    .window-container .window-tab-list {
        text-align: left;
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
        border-top-left-radius: 3px;
        border-top-right-radius: 3px;

        -webkit-padding-start: 12px;
        -webkit-padding-end: 12px;
        -moz-padding-start: 12px;
        -moz-padding-end: 12px;
        font-size: 0.85em;
        /*color: whitesmoke;*/
    }

</style>
