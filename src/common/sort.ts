import {NesoiTab, Sorter} from "./ds";

export class TabDomainSorter implements Sorter<NesoiTab> {
    compare(a: NesoiTab, b: NesoiTab, order: "asc" | "desc") {
        const multiplier = order == "asc" ? 1 : -1;
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
    compare(a: NesoiTab, b: NesoiTab, order: "asc" | "desc") {
        const multiplier = order == "asc" ? 1 : -1;
        let val = 0;
        if (a.domain > b.domain) {
            val = 1;
        } else if (a.domain < b.domain) {
            val = -1;
        }
        return val * multiplier;
    }
}
