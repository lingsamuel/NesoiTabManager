import {NesoiTab, NesoiWindow, Sorter} from "./ds";


export type SorterOpts = {
    order: "asc" | "desc",
}

export type DomainSorterOpts = SorterOpts & {}

export type TitleSorterOpts = SorterOpts & {
    reverse_title: boolean, // Useful when website has pattern in title tail
}

export class TabDomainSorter implements Sorter<NesoiTab> {
    compare(a: NesoiTab, b: NesoiTab, opts: DomainSorterOpts) {
        const multiplier = opts.order == "asc" ? 1 : -1;
        let val = 0;
        if (a.domain > b.domain) {
            val = 1;
        } else if (a.domain < b.domain) {
            val = -1;
        }
        return val * multiplier;
    }
}

export class TabTitleSorter implements Sorter<NesoiTab> {
    compare(a: NesoiTab, b: NesoiTab, opts: TitleSorterOpts) {
        const multiplier = opts.order == "asc" ? 1 : -1;
        let val = 0;
        let v1 = a.title;
        let v2 = b.title;
        if (opts.reverse_title) {
            v1 = v1.split("").reverse().join("");
            v2 = v2.split("").reverse().join("");
        }
        if (v1 > v2) {
            val = 1;
        } else if (v1 < v2) {
            val = -1;
        }
        return val * multiplier;
    }
}

export function applySort(windows: NesoiWindow[], sorter: Sorter<NesoiTab>, opts: SorterOpts) {
    windows.forEach(window => {
        window.tabs.sort((a, b) => {
            return sorter.compare(a, b, opts);
        });
    });
}
