import * as fs from "fs";
import * as path from "path"

type ScopeName = string;
type OriginalId = string;
type HumanizedId = string;

interface StoredRecord {
  scope: ScopeName;
  humanizedId: HumanizedId;
  originalId: OriginalId;
  expirationTime: number | null; // unix ms, null = never expires
}

interface HumanizedIdStoreOptions {
  storageFilePath?: string;
  lockTimeoutMs?: number;
  lockRetryDelayMs?: number;
  maxLockWaitMs?: number;
  maxIdsPerScope?: number;
  wordsPerId?: number;
  separator?: string;
}

export class HumanizedIdStore {
  private readonly storageFilePath: string;
  private readonly lockFilePath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly maxLockWaitMs: number;
  private readonly maxIdsPerScope: number;
  private readonly wordsPerId: number;
  private readonly separator: string;

  // Small starter dictionary. Keep words short and URL-safe.
  private static readonly DICTIONARY = [
    "fast", "calm", "blue", "red", "gold", "lime", "wolf", "dog",
    "cat", "fox", "lake", "moon", "star", "sun",
    "rain", "wind", "fire", "dust", "rock", "bird", "ant", "bee",
    "ship", "wave", "ice", "mint", "clay", "frog", "hawk", "seed",
    "lucky", "easy", "best", "widget", "snake", "lion", "tiger",
    "lobster", "train", "wheel", "monk", "tree", "token", "happy",
    "fish", "lazy", "purple", "pasta", "kick", "jack", "plane", "wall",
    "funky", "fruit", "jazzy", "jelly"
  ];

  constructor(options: HumanizedIdStoreOptions) {
    this.storageFilePath = options.storageFilePath || path.join(process.env.OPENCLAW_STATE_DIR || '/tmp', 'oc-memorable-ids.txt');
    this.lockFilePath = `${this.storageFilePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? 50;
    this.maxLockWaitMs = options.maxLockWaitMs ?? 5_000;
    this.maxIdsPerScope = options.maxIdsPerScope ?? 320;
    this.wordsPerId = options.wordsPerId ?? 3;
    this.separator = options.separator ?? "-";

    this.ensureStorageExists();
  }

  /**
   * Creates a new or returns an existing humanized id for the original id inside the given scope.
   *
   * expiration can be:
   * - Date
   * - unix timestamp in ms
   * - null/undefined => no expiration
   */
  getMemorableId(
    scope: string,
    originalId: string,
    expiration?: Date | number | null
  ): string {
    this.validateScope(scope);
    this.validateId(originalId);

    const expirationTime = this.normalizeExpiration(expiration);

    return this.withLock(() => {
      const records = this.loadRecords();
      const now = Date.now();
      const activeRecords = this.removeExpiredRecordsInMemory(records, now);

      // Idempotent: if originalId already has a humanized ID in this scope, return it.
      const existing = activeRecords.find(
        (r) => r.scope === scope && r.originalId === originalId
      );

      if (existing) {
        // Optional behavior: extend expiration if a new one is provided
        if (expirationTime !== undefined) {
          existing.expirationTime = expirationTime;
          this.saveRecords(activeRecords);
        }
        return existing.humanizedId;
      }

      const scopeRecords = activeRecords.filter((r) => r.scope === scope);
      if (scopeRecords.length >= this.maxIdsPerScope) {                
        throw new Error(
          `Scope "${scope}" has reached the limit of ${this.maxIdsPerScope} IDs, remove your temp file, e.g. "unlink /tmp/oc-memorable-ids.txt"`
        );
      }

      const humanizedId = this.generateUniqueHumanizedId(scopeRecords);

      activeRecords.push({
        scope,
        humanizedId,
        originalId,
        expirationTime: expirationTime ?? null,
      });

      this.saveRecords(activeRecords);
      return humanizedId;
    });
  }

  /**
   * Returns the original id for a scope + humanized id, or null if not found / expired.
   */
  getOriginalId(
    scope: string,
    humanizedId: string
  ): string | null {
    this.validateScope(scope);
    this.validateId(humanizedId);

    return this.withLock(() => {
      const records = this.loadRecords();
      const now = Date.now();
      const activeRecords = this.removeExpiredRecordsInMemory(records, now);

      const found = activeRecords.find(
        (r) => r.scope === scope && r.humanizedId === humanizedId
      );

      // Persist cleanup if expired rows were removed
      if (activeRecords.length !== records.length) {
        this.saveRecords(activeRecords);
      }

      return found?.originalId ?? null;
    });
  }

  /**
   * Removes all records for a scope.
   */
  cleanScope(scope: string): void {
    this.validateScope(scope);

    this.withLock(() => {
      const records = this.loadRecords();
      const filtered = records.filter((r) => r.scope !== scope);
      this.saveRecords(filtered);
    });
  }

  // -------------------------
  // Internal helpers
  // -------------------------

  private ensureStorageExists(): void {
    const dir = path.dirname(this.storageFilePath);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.storageFilePath)) {
      fs.writeFileSync(this.storageFilePath, "", { encoding: "utf8" });
    }
  }

  private validateScope(scope: string): void {
    if (!scope || typeof scope !== "string") {
      throw new Error("scope must be a non-empty string");
    }
    if (scope.includes(":") || scope.includes("\n")) {
      throw new Error('scope must not contain ":" or newlines');
    }
  }

  private validateId(value: string): void {
    if (!value || typeof value !== "string") {
      throw new Error("id must be a non-empty string");
    }
    if (value.includes(":") || value.includes("\n")) {
      throw new Error('id must not contain ":" or newlines');
    }
  }

  private normalizeExpiration(
    expiration?: Date | number | null
  ): number | null | undefined {
    if (expiration === undefined || expiration === null) {
      // Return +14 days from now by default
      return Date.now() + 14 * 24 * 60 * 60 * 1000;
    }

    const time =
      expiration instanceof Date ? expiration.getTime() : expiration;

    if (!Number.isFinite(time)) {
      throw new Error("expiration must be a valid Date, timestamp, null, or undefined");
    }

    return time;
  }

  private parseLine(line: string): StoredRecord | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(":");
    if (parts.length !== 4) {
      throw new Error(`Invalid storage line format: ${line}`);
    }

    const [scope, humanizedId, originalId, expirationRaw] = parts;

    return {
      scope,
      humanizedId,
      originalId,
      expirationTime: expirationRaw === "null" ? null : Number(expirationRaw),
    };
  }

  private formatLine(record: StoredRecord): string {
    return [
      record.scope,
      record.humanizedId,
      record.originalId,
      record.expirationTime === null ? "null" : String(record.expirationTime),
    ].join(":");
  }

  private loadRecords(): StoredRecord[] {
    const content = fs.readFileSync(this.storageFilePath, "utf8");
    if (!content.trim()) return [];

    return content
      .split("\n")
      .map((line) => this.parseLine(line))
      .filter((r): r is StoredRecord => r !== null);
  }

  private saveRecords(records: StoredRecord[]): void {
    const tempFile = `${this.storageFilePath}.tmp`;
    const data =
      records.map((r) => this.formatLine(r)).join("\n") +
      (records.length > 0 ? "\n" : "");

    fs.writeFileSync(tempFile, data, "utf8");
    fs.renameSync(tempFile, this.storageFilePath);
  }

  private removeExpiredRecordsInMemory(
    records: StoredRecord[],
    now: number
  ): StoredRecord[] {
    return records.filter((r) => {
      return r.expirationTime === null || r.expirationTime > now;
    });
  }

  private generateUniqueHumanizedId(scopeRecords: StoredRecord[]): string {
    const used = new Set(scopeRecords.map((r) => r.humanizedId));

    // Theoretical capacity check
    const capacity = Math.pow(HumanizedIdStore.DICTIONARY.length, this.wordsPerId);
    if (this.maxIdsPerScope > capacity) {
      throw new Error(
        `Configuration invalid: maxIdsPerScope (${this.maxIdsPerScope}) exceeds ID space capacity (${capacity})`
      );
    }

    // Since the scope limit is small (<= 32), random retries are fine.
    for (let attempt = 0; attempt < 500; attempt++) {
      const candidate = this.generateRandomHumanizedId();
      if (!used.has(candidate)) {
        return candidate;
      }
    }

    throw new Error("Could not generate a unique humanized ID after many attempts");
  }

  private generateRandomHumanizedId(): string {
    const words: string[] = [];
    for (let i = 0; i < this.wordsPerId; i++) {
      const idx = Math.floor(Math.random() * HumanizedIdStore.DICTIONARY.length);
      words.push(HumanizedIdStore.DICTIONARY[idx as number]);
    }
    return words.join(this.separator);
  }

  /**
   * Cross-process lock using exclusive lock file creation.
   * Uses Atomics.wait for synchronous spin-sleep between retries.
   */
  private withLock<T>(fn: () => T): T {
    const start = Date.now();
    // Shared buffer used solely as a target for Atomics.wait (sync sleep).
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

    while (true) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(
          this.lockFilePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        );

        fs.writeSync(
          fd,
          JSON.stringify({ pid: process.pid, createdAt: Date.now() })
        );
        fs.closeSync(fd);
        fd = undefined;

        try {
          return fn();
        } finally {
          try { fs.unlinkSync(this.lockFilePath); } catch { /* ignore */ }
        }
      } catch (err: any) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }

        if (err?.code !== "EEXIST") {
          throw err;
        }

        // Lock exists — check if it's stale.
        if (this.isLockStale()) {
          try { fs.unlinkSync(this.lockFilePath); } catch { /* ignore */ }
          continue;
        }

        if (Date.now() - start >= this.maxLockWaitMs) {
          throw new Error("Timed out waiting for storage lock");
        }

        Atomics.wait(sleepBuf, 0, 0, this.lockRetryDelayMs);
      }
    }
  }

  private isLockStale(): boolean {
    try {
      const stat = fs.statSync(this.lockFilePath);
      return Date.now() - stat.mtimeMs > this.lockTimeoutMs;
    } catch {
      return false;
    }
  }
}

let store: HumanizedIdStore | null = null;

function getStore(): HumanizedIdStore {
  if (store === null) {
    store = new HumanizedIdStore({});
  }
  return store;
}

export function getMemorableId(scope: string, originalId: string): string {
  return getStore().getMemorableId(scope, originalId);
}

export function memorableToOriginalId(scope: string, memorableId: string): string | null {
  return getStore().getOriginalId(scope, memorableId);
}
