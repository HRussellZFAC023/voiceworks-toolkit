import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'src/features/JoiTool.ts'), 'utf8');

describe('JoiTool observer lifecycle', () => {
    it('keeps the repair observer through deactivate/reactivate and removes it only on disable', () => {
        const disableBlock = source.slice(source.indexOf('public disable()'), source.indexOf('public toggle()'));
        const deactivateBlock = source.slice(source.indexOf('private deactivate()'), source.indexOf('// ------------------------------------------------------------------------\n    // Event Listeners'));

        expect(disableBlock).toContain("CentralObserver.unregister('joi-tool')");
        expect(deactivateBlock).not.toContain("CentralObserver.unregister('joi-tool')");
    });
});
