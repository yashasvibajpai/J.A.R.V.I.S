import { resolve } from 'path';
import { existsSync } from 'fs';

export interface GBrainCartridge {
    id: {
        idx: string;
        idx_n: string[];
        notation: string;
    };
    persona: {
        role: string;
        context: string[];
        boundaries: string[];
        rules: string[];
    };
    model: {
        instance: string;
        ifEmbeddings: boolean;
        embeddings: string[];
        fallback: string[];
        optional: boolean;
    };
    cartridgeExtensions: {
        local: string[];
        isRouted: boolean;
        routerExtensions: string[];
    };
}

export function contextualInsertionFunction(targetPath?: string): string {
    const resolvedPath = targetPath ? resolve(targetPath) : resolve(process.cwd(), 'data');
    return resolvedPath;
}
