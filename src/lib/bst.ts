// Binary Search Tree

// Balance a BST while Chrome Window/Tab id may be consecutive
export function balance<T>(root: BST<T>): BST<T> {
    const nodes: BST<T>[] = storeBST(root);

    return buildTreeFromSortedArray(nodes);
}

function storeBST<T>(node: BST<T> | null): BST<T>[] {
    if (node == null) {
        return [];
    }
    const nodes: BST<T>[] = [];
    nodes.push(...storeBST(node.left));
    nodes.push(node);
    nodes.push(...storeBST(node.right));
    return nodes;
}

export function buildTreeFromSortedArray<T>(nodes: BST<T>[]): BST<T> {
    return buildTreeFromArrayInternal(nodes, 0, nodes.length - 1)!;
}

function buildTreeFromArrayInternal<T>(nodes: BST<T>[], start: number, end: number): BST<T> | null {
    if (start > end) {
        return null;
    }
    const mid = Math.floor((start + end) / 2);
    const root = nodes[mid];
    root.left = buildTreeFromArrayInternal(nodes, start, mid - 1);
    root.right = buildTreeFromArrayInternal(nodes, mid + 1, end);
    return root;
}

export class BST<T> {
    data: T | null;
    left: BST<T> | null;
    right: BST<T> | null;

    constructor(d: T | null) {
        this.data = d;
        this.left = this.right = null;
    }

    preOrder(node?: BST<T> | null) {
        if (node == null) {
            node = this;
        }
        console.log(node.data);
        if (node.left != null) {
            this.preOrder(node.left);
        }
        if (node.right != null) {
            this.preOrder(node.right);
        }
    }

    add(key: number) {

    }

    delete(key: number) {

    }

    search(key: number): BST<T> {
        let root: BST<T> = this;

        // while (root != null) {
        //     // pass right subtree as new tree
        //     if (key > root.data!.end) {
        //         if (root.right == null) {
        //             return root;
        //         }
        //         root = root.right;
        //     } else if (key < root.data!.start) {
        //         if (root.left == null) {
        //             return root;
        //         }
        //         root = root.left;
        //     } else {
        //         return root; // if the key is found return 1
        //     }
        // }
        return root;
    }
}
