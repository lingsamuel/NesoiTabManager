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
            <div class="tab-entry">
            </div>
            <ul>
                <li v-for="(tab, tabIndex) in chromeWindow.tabs" draggable="true">
                    <img class="tab-icon" v-if="tab && tab.favIconUrl" :src="tab.favIconUrl"
                         alt="FavIcon"/>
                    <a class="nesoi-link" :href="tab.url" target="_blank"
                       v-on:click="activateTab(tab, tab.id, tab.windowId, $event)">
                        {{ tab.title }}</a>
                    <span class="btn"
                          v-on:click="activateTab(tab, tab.id, tab.windowId)">GOTO</span>
                    <span class="btn" v-on:click="closeTab(tab.id)">X</span>
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
            closeTab(tabId){
                closeTab(tabId);
            }
        }
    }
</script>
<style>
    .window-header {
        line-height: 50px;
    }

    .container .tab-icon {
        border-radius: 0;
    }

    .nesoi-link {
        text-decoration: none;
        color: black;
    }

    .nesoi-link:hover {
        text-decoration: underline;
    }

    .window-container {
        /*display: flex;*/
        margin: 26px 0;
        /*border-width: thin;*/
        /*border-style: solid;*/
        border: 1px solid rgba(27, 31, 35, 0.15)
    }

    .window-container .window-tab-list {
        text-align: left;
    }

    .window-container .window-tab-list ul {
        list-style: none;
        padding: 0;
    }

    .window-container .window-tab-list ul li {
        height: 40px;
        line-height: 40px;
    }

    .window-container .window-tab-list ul li img {
        width: 16px;
        height: 16px;
        padding: 8px;
    }

    .window-container .window-tab-list ul li a {
        text-decoration: none;
        color: black;
        height: 32px;
        position: absolute;
    }

    .window-container .window-tab-list ul li a:hover {
        text-decoration: underline;
        color: black;
        height: 32px;
        position: absolute;
    }

    .window-container .window-tab-list ul li span {
        float: right;
        height: 32px;
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
