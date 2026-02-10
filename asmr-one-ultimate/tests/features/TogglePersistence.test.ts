/**
 * Tests for JoiTool and Visualizer toggle listener persistence.
 *
 * Bug: deactivate() was cleaning up ALL event listeners including the
 * toggle listener itself, so after one toggle off, the toggle button
 * stopped working. Fix: separate persistent listeners from activation-scoped ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Minimal EventBus stub
// ============================================================================

type Listener = (...args: any[]) => void;

class StubEventBus {
    private listeners = new Map<string, Set<{ fn: Listener; cleanup: () => void }>>();

    on(event: string, fn: Listener): () => void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        const entry = { fn, cleanup: () => { this.listeners.get(event)?.delete(entry); } };
        this.listeners.get(event)!.add(entry);
        return entry.cleanup;
    }

    emit(event: string, payload?: any): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const entry of [...set]) {
            entry.fn(payload);
        }
    }

    listenerCount(event: string): number {
        return this.listeners.get(event)?.size ?? 0;
    }
}

// ============================================================================
// Simulated JoiTool pattern (matches src/features/JoiTool.ts)
// ============================================================================

class SimulatedJoiTool {
    public isActive = false;
    public toggleCallCount = 0;
    private eventCleanups: (() => void)[] = [];
    private persistentCleanups: (() => void)[] = [];

    constructor(private bus: StubEventBus) {}

    enable(): void {
        this.setupPersistentListeners();
    }

    toggle(): void {
        this.toggleCallCount++;
        if (this.isActive) {
            this.deactivate();
        } else {
            this.activate();
        }
    }

    private activate(): void {
        this.isActive = true;
        this.setupEventListeners();
    }

    private deactivate(): void {
        this.isActive = false;
        this.eventCleanups.forEach(fn => fn());
        this.eventCleanups = [];
    }

    private setupPersistentListeners(): void {
        if (this.persistentCleanups.length > 0) return;
        this.persistentCleanups.push(this.bus.on('joi:toggle', () => this.toggle()));
        this.persistentCleanups.push(this.bus.on('config:change', () => {}));
    }

    private setupEventListeners(): void {
        this.eventCleanups.push(this.bus.on('whisper:update', () => {}));
        this.eventCleanups.push(this.bus.on('track:change', () => {}));
    }
}

// ============================================================================
// Simulated broken pattern (old behavior before fix)
// ============================================================================

class BrokenJoiTool {
    public isActive = false;
    public toggleCallCount = 0;
    private eventCleanups: (() => void)[] = [];

    constructor(private bus: StubEventBus) {}

    enable(): void {
        this.setupEventListeners();
    }

    toggle(): void {
        this.toggleCallCount++;
        if (this.isActive) {
            this.deactivate();
        } else {
            this.activate();
        }
    }

    private activate(): void {
        this.isActive = true;
    }

    private deactivate(): void {
        this.isActive = false;
        // BUG: cleans up ALL listeners including toggle
        this.eventCleanups.forEach(fn => fn());
        this.eventCleanups = [];
    }

    private setupEventListeners(): void {
        // Toggle listener mixed in with activation-scoped listeners
        this.eventCleanups.push(this.bus.on('joi:toggle', () => this.toggle()));
        this.eventCleanups.push(this.bus.on('whisper:update', () => {}));
        this.eventCleanups.push(this.bus.on('track:change', () => {}));
    }
}

// ============================================================================
// Tests
// ============================================================================

describe('Toggle listener persistence', () => {
    let bus: StubEventBus;

    beforeEach(() => {
        bus = new StubEventBus();
    });

    describe('Fixed JoiTool (persistent listeners)', () => {
        it('toggle listener survives deactivate', () => {
            const tool = new SimulatedJoiTool(bus);
            tool.enable();

            // First toggle: activate
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(true);
            expect(tool.toggleCallCount).toBe(1);

            // Second toggle: deactivate
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(false);
            expect(tool.toggleCallCount).toBe(2);

            // Third toggle: should still work (listener must persist)
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(true);
            expect(tool.toggleCallCount).toBe(3);
        });

        it('activation-scoped listeners are cleaned up on deactivate', () => {
            const tool = new SimulatedJoiTool(bus);
            tool.enable();

            // Before activation: no activation-scoped listeners yet
            const whisperBefore = bus.listenerCount('whisper:update');
            expect(whisperBefore).toBe(0);

            // Activate: adds another set of activation-scoped listeners
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(true);
            const whisperActive = bus.listenerCount('whisper:update');
            expect(whisperActive).toBe(1);

            // Deactivate: should clean up activation-scoped listeners
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(false);
            // Both sets cleaned
            expect(bus.listenerCount('whisper:update')).toBe(0);
        });

        it('persistent listeners are not duplicated on multiple enable calls', () => {
            const tool = new SimulatedJoiTool(bus);
            tool.enable();
            tool.enable(); // should not re-register

            expect(bus.listenerCount('joi:toggle')).toBe(1);
            expect(bus.listenerCount('config:change')).toBe(1);
        });

        it('toggle works after multiple activate/deactivate cycles', () => {
            const tool = new SimulatedJoiTool(bus);
            tool.enable();

            for (let i = 0; i < 10; i++) {
                bus.emit('joi:toggle');
            }
            // 10 toggles: 5 activates + 5 deactivates
            expect(tool.toggleCallCount).toBe(10);
            expect(tool.isActive).toBe(false);
        });
    });

    describe('Broken JoiTool (reproduces bug)', () => {
        it('toggle listener is lost after first deactivate', () => {
            const tool = new BrokenJoiTool(bus);
            tool.enable();

            // First toggle: activate
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(true);

            // Second toggle: deactivate (cleans up toggle listener)
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(false);

            // Third toggle: BROKEN - listener was cleaned up
            bus.emit('joi:toggle');
            expect(tool.isActive).toBe(false); // Still false — listener is gone
            expect(tool.toggleCallCount).toBe(2); // Only 2, not 3
        });
    });
});
