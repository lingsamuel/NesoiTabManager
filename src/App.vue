<template>
    <div id="app">
        <div class="toolbar">
            <span class="btn" v-on:click="sortByDomainEachWindow()">sortByDomain(EachWindow)</span>
            <span class="btn" v-on:click="sortByDomainMergeWindow()">sortByDomain(MergeWindow)</span>
            <span class="btn" v-on:click="sortByTitleEachWindow()">sortByTitle(EachWindow)</span>
            <span class="btn" v-on:click="sortByTitleMergeWindow()">sortByTitle(MergeWindow)</span>
        </div>
        <div class="container">
            <div class="window-container" v-for="(list, listIndex) in lists">
                <div class="window-header">
                    <div class="window-title">
                        <span>Window {{ list.id }} | {{ list.tabs.length }} tab(s)</span>
                        <span class="title">{{ list.title }}</span>
                    </div>
                </div>
                <ul>
                    <li v-for="(tab, tabIndex) in list.tabs" draggable="true">
                        <img class="tab-icon" v-if="tab && tab.favIconUrl" :src="tab.favIconUrl" alt="FavIcon"/>
                        <a :href="tab.url" target="_blank" v-on:click="activateTab(tab, tab.id, list.id, $event)">
                            {{ tab.title }}</a>
                        <span class="btn" v-on:click="activateTab(tab, tab.id, list.id)">GOTO</span>
                        <span class="btn" v-on:click="list.tabs.splice(tabIndex, 1)">X</span>
                    </li>
                </ul>
            </div>
        </div>
    </div>
</template>
<script>
    import tab_storage from './common/tab_storage'
    import browser from 'webextension-polyfill'
    import tab_manager from "./common/tab_manager";
    import {getDomainName} from "./common/url_utils"

    export default {
        data() {
            return {
                lists: [],
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
                console.log(tab);
                console.log(tabId);
                tab_manager.activateTab(tabId, windowId);
            },
            async init() {
                this.lists = await tab_manager.getAllTabs();
            },
            async sortByDomainEachWindow() {
                const lists = await tab_manager.getAllTabs();
                lists.forEach(list => list.tabs.sort((x, y) => {
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
                }));
                this.lists = lists;
            },
            async sortByDomainMergeWindow() {

            },
            async sortByTitleEachWindow() {

            },
            async sortByTitleMergeWindow() {

            },
        }
    }
</script>
<style>
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
    }

    .container {
        max-width: 680px;
        margin: 0 auto;
        border: 0;
    }

    .container .tab-icon {
        border-radius: 0;
    }

    .window-container {
        margin: 26px 0;
        border-width: thin;
        border-style: solid;
    }

    .window-container ul {
        list-style: none;
        padding: 0;
    }

    .window-container ul li {
        height: 40px;
        line-height: 40px;
    }

    .window-container ul li img {
        width: 16px;
        height: 16px;
        padding: 8px;
    }

    .window-container ul li a {
        text-decoration: none;
        color: black;
        height: 32px;
        position: absolute;
    }

    .window-container ul li a:hover {
        text-decoration: underline;
        color: black;
        height: 32px;
        position: absolute;
    }

    .window-container ul li span {
        float: right;
        height: 32px;
    }

    .window-container .window-title {
        padding: 16px;
        background-color: gray;
        font-size: 24px;
        color: whitesmoke;
    }

</style>

