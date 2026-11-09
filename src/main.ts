import sdk, {
    EventListenerRegister,
    FFmpegInput,
    MediaObject,
    MixinProvider,
    Notifier,
    NotifierOptions,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
    WritableDeviceState,
} from '@scrypted/sdk';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { systemManager, mediaManager } = sdk;

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

const MARKER = '.scrypted-nvr-drive';
const MAX_DROPBOX_BYTES = 140 * 1024 * 1024;

const MODES = ['Off', 'Keep only clips the AI asks for', 'Keep every motion clip'];
type CameraMode = 'off' | 'ai' | 'all';

function modeId(choice?: string): CameraMode {
    const c = (choice ?? '').toLowerCase();
    if (c.includes('ai')) return 'ai';
    if (c.includes('every')) return 'all';
    return 'off';
}

class NoRetryError extends Error { }

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function safeName(s: string): string {
    return (s || 'camera').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'camera';
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function dateFolder(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(d: Date): string {
    return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function mimeFor(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.json') return 'application/json';
    return 'application/octet-stream';
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function isMountPoint(p: string): Promise<boolean> {
    try {
        const a = await fs.stat(p);
        const b = await fs.stat(path.dirname(p));
        return a.dev !== b.dev;
    } catch {
        return false;
    }
}

async function freeBytes(p: string): Promise<number | undefined> {
    try {
        const s = await fs.statfs(p);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return undefined;
    }
}

function fmtBytes(n?: number): string {
    if (n === undefined) return 'unknown';
    return `${(n / (1024 ** 3)).toFixed(1)} GB`;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            last = e;
            if (e instanceof NoRetryError || i === attempts - 1)
                break;
            await new Promise(r => setTimeout(r, 2000 * (i + 1) * (i + 1)));
        }
    }
    throw last;
}

async function httpJson(url: string, init: RequestInit, timeoutMs = 30000): Promise<any> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`${url} returned ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
}

function runFfmpeg(ffmpegPath: string, args: string[], killAfterMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, args);
        let stderr = '';
        p.stderr.on('data', d => (stderr += d.toString()));
        const timer = setTimeout(() => p.kill('SIGKILL'), killAfterMs);
        p.on('error', e => {
            clearTimeout(timer);
            reject(e);
        });
        p.on('close', code => {
            clearTimeout(timer);
            if (code === 0)
                resolve(stderr);
            else
                reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(0, 300)}`));
        });
    });
}

async function getCameraInput(camera: VideoCamera): Promise<string[]> {
    let mo: MediaObject;
    try {
        mo = await camera.getVideoStream({ destination: 'local-recorder' });
    } catch {
        mo = await camera.getVideoStream();
    }
    const input = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput);
    if (input.inputArguments?.length)
        return input.inputArguments;
    if (!input.url)
        throw new Error('Camera stream did not return an FFmpeg input URL');
    return ['-i', input.url];
}

async function walk(dir: string, out: { file: string; mtimeMs: number; size: number }[] = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries)
        return out;
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            await walk(p, out);
        } else if (/\.(mp4|jpg|json)$/i.test(e.name)) {
            const st = await fs.stat(p).catch(() => null);
            if (st)
                out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

interface Meta {
    cameraId: string;
    cameraName: string;
    severity?: string;
    summary?: string;
    reason?: string;
}

interface Staged {
    cameraId: string;
    cameraName: string;
    seconds: number;
    mode: 'ai' | 'all';
    startedAt: number;
    file: string;
    done: boolean;
    failed: boolean;
    keep: boolean;
    finalized: boolean;
    meta?: Meta;
    timer?: NodeJS.Timeout;
}

interface StoreItem {
    file: string;
    rel: string;
}

interface Token {
    token: string;
    expires: number;
}

/* ------------------------------------------------------------------ */
/* Per-camera mixin                                                     */
/* ------------------------------------------------------------------ */

class NvrMixin extends SettingsMixinDeviceBase<VideoCamera> implements Settings {
    provider: NvrStoragePlugin;
    listener?: EventListenerRegister;

    storageSettings = new StorageSettings(this, {
        mode: {
            title: 'Clip recording',
            description:
                '"Keep only clips the AI asks for" records a clip on every motion event, then keeps it only if the ' +
                'AI Vision Alerts plugin asks for it (otherwise it is deleted). This way the clip starts at the motion, ' +
                'not after the AI finishes thinking.',
            type: 'string',
            choices: MODES,
            defaultValue: MODES[0],
        },
        clipSeconds: {
            title: 'Clip length (seconds)',
            type: 'number',
            defaultValue: 30,
        },
        recordNow: {
            title: 'Record a test clip now',
            description: 'Records and saves a clip to your enabled destinations. Check the camera console for results.',
            type: 'button',
            onPut: async () => {
                await this.provider.requestClip(
                    { cameraId: this.id, cameraName: this.cameraName(), reason: 'manual test' },
                    this.seconds(),
                );
            },
        },
    });

    constructor(options: SettingsMixinDeviceOptions<VideoCamera>, provider: NvrStoragePlugin) {
        super(options);
        this.provider = provider;
        const prev = this.provider.activeMixins.get(this.id);
        if (prev && prev !== this) {
            prev.listener?.removeListener();
            prev.listener = undefined;
        }
        this.provider.activeMixins.set(this.id, this);
        this.sync();

        this.listener = systemManager.listenDevice(
            this.id,
            ScryptedInterface.MotionSensor,
            (_source, _details, data: boolean) => {
                if (data === true)
                    this.provider
                        .onMotion(this.id, this.cameraName())
                        .catch(e => this.console.error('motion handling failed', e));
            },
        );
    }

    cameraName(): string {
        return systemManager.getDeviceById(this.id)?.name ?? 'Camera';
    }

    seconds(): number {
        return Math.min(300, Math.max(5, Math.round(Number(this.storageSettings.values.clipSeconds ?? 30))));
    }

    sync() {
        this.provider.cameraModes.set(this.id, {
            mode: modeId(this.storageSettings.values.mode),
            seconds: this.seconds(),
        });
    }

    dispose() {
        this.listener?.removeListener();
        this.listener = undefined;
        if (this.provider.activeMixins.get(this.id) === this) {
            this.provider.activeMixins.delete(this.id);
            this.provider.cameraModes.delete(this.id);
        }
    }

    async release(): Promise<void> {
        await super.release();
        this.dispose();
    }

    getMixinSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putMixinSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
        this.sync();
    }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                               */
/* ------------------------------------------------------------------ */

export default class NvrStoragePlugin extends ScryptedDeviceBase implements MixinProvider, Settings, Notifier {
    staged = new Map<string, Staged>();
    cameraModes = new Map<string, { mode: CameraMode; seconds: number }>();
    activeMixins = new Map<string, NvrMixin>();
    tokens: { dropbox?: Token; google?: Token } = {};
    lastError = '';

    storageSettings = new StorageSettings(this, {
        /* ---- Local / USB / network drive ---- */
        localEnabled: {
            group: 'Local, USB or network drive',
            title: 'Save to local / USB / network drive',
            type: 'boolean',
            defaultValue: true,
        },
        mountPath: {
            group: 'Local, USB or network drive',
            title: 'Drive mount path',
            description:
                'Folder where your drive is mounted inside the Scrypted add-on, e.g. /data/usb. ' +
                'Press "Diagnose storage" to see which folders the add-on can reach.',
            defaultValue: '/data/usb',
        },
        folderName: {
            group: 'Local, USB or network drive',
            title: 'Folder on the drive',
            description: 'Recordings go in <mount path>/<this folder>/<camera>/<date>/.',
            defaultValue: 'scrypted-nvr',
        },
        requireMarker: {
            group: 'Local, USB or network drive',
            title: 'Require drive marker (recommended)',
            description:
                'Refuse to write unless the marker file exists on the drive. If the USB drive is unplugged, ' +
                'Home Assistant can leave an empty folder behind, and without this safeguard recordings would ' +
                'silently fill the internal disk.',
            type: 'boolean',
            defaultValue: true,
        },
        createMarker: {
            group: 'Local, USB or network drive',
            title: 'Create drive marker',
            description: 'Run once while the drive is mounted. Refuses if the path is not a separate mounted drive.',
            type: 'button',
            onPut: async () => {
                await this.createMarker();
            },
        },
        retentionDays: {
            group: 'Local, USB or network drive',
            title: 'Delete files older than (days)',
            description: '0 keeps everything. Only files inside the folder above are ever deleted.',
            type: 'number',
            defaultValue: 30,
        },
        maxSizeGb: {
            group: 'Local, USB or network drive',
            title: 'Maximum total size (GB)',
            description: '0 means no limit. Oldest files are deleted first when the limit is exceeded.',
            type: 'number',
            defaultValue: 0,
        },

        /* ---- Dropbox ---- */
        dropboxEnabled: {
            group: 'Dropbox',
            title: 'Upload to Dropbox',
            type: 'boolean',
            defaultValue: false,
        },
        dropboxAppKey: { group: 'Dropbox', title: 'App key' },
        dropboxAppSecret: { group: 'Dropbox', title: 'App secret', type: 'password' },
        dropboxRefreshToken: {
            group: 'Dropbox',
            title: 'Refresh token',
            description: 'See the README for the one-time steps to get this.',
            type: 'password',
        },
        dropboxFolder: {
            group: 'Dropbox',
            title: 'Dropbox folder',
            description: 'Created automatically. Files are organized by camera and date inside it.',
            defaultValue: '/Scrypted NVR',
        },

        /* ---- Google Drive ---- */
        driveEnabled: {
            group: 'Google Drive',
            title: 'Upload to Google Drive',
            type: 'boolean',
            defaultValue: false,
        },
        googleClientId: { group: 'Google Drive', title: 'OAuth client ID' },
        googleClientSecret: { group: 'Google Drive', title: 'OAuth client secret', type: 'password' },
        googleRefreshToken: {
            group: 'Google Drive',
            title: 'Refresh token',
            description: 'See the README for the one-time steps to get this.',
            type: 'password',
        },
        driveFolderId: {
            group: 'Google Drive',
            title: 'Drive folder ID (optional)',
            description:
                'Leave blank to let the plugin create and use a folder named "Scrypted NVR". ' +
                'Only set this if your token has the full Drive scope.',
        },

        /* ---- General ---- */
        stagingPath: {
            group: 'General',
            title: 'Staging folder (optional)',
            description:
                'Where clips are written temporarily before being stored. Blank uses the plugin\'s own data folder. ' +
                'Staged clips that were never kept are deleted automatically.',
        },
        graceSeconds: {
            group: 'General',
            title: 'Wait for AI decision (seconds)',
            description: 'After a clip finishes recording, how long to wait for the AI to ask for it before deleting it.',
            type: 'number',
            defaultValue: 90,
        },
        saveAnyNotifierImages: {
            group: 'General',
            title: 'Also save images from other notifier calls',
            description: 'Saves any image sent to this plugin as a notification, not just AI Vision Alerts ones.',
            type: 'boolean',
            defaultValue: false,
        },
        diagnose: {
            group: 'General',
            title: 'Diagnose storage',
            description: 'Logs which folders the add-on can see, whether they are writable, free space, and mount status.',
            type: 'button',
            onPut: async () => {
                await this.diagnose();
            },
        },
        testStorage: {
            group: 'General',
            title: 'Write test file to all destinations',
            type: 'button',
            onPut: async () => {
                await this.testStorage();
            },
        },
        showStatus: {
            group: 'General',
            title: 'Show status',
            type: 'button',
            onPut: async () => {
                this.console.log(await this.statusText());
            },
        },
    });

    constructor(nativeId?: string) {
        super(nativeId);
        this.cleanStaging().catch(() => undefined);
        setTimeout(() => this.initMixins().catch(() => undefined), 2_000).unref();
        setTimeout(() => this.enforceRetention().catch(e => this.console.error('retention failed', e)), 60_000).unref();
        setInterval(() => {
            this.enforceRetention().catch(e => this.console.error('retention failed', e));
            this.cleanStaging().catch(() => undefined);
        }, 30 * 60_000).unref();
    }

    async initMixins() {
        const state = systemManager.getSystemState();
        for (const id of Object.keys(state)) {
            const dev = systemManager.getDeviceById<Settings>(id);
            if (dev?.mixins?.includes(this.id)) {
                Promise.resolve(dev.getSettings?.()).catch(() => undefined);
            }
        }
    }

    /* ---------------- Settings / mixin plumbing ---------------- */

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[] | null | undefined | void> {
        if (type !== ScryptedDeviceType.Camera && type !== ScryptedDeviceType.Doorbell)
            return;
        if (!interfaces.includes(ScryptedInterface.VideoCamera))
            return;
        return [ScryptedInterface.Settings];
    }

    async getMixin(
        mixinDevice: any,
        mixinDeviceInterfaces: ScryptedInterface[],
        mixinDeviceState: WritableDeviceState,
    ): Promise<any> {
        return new NvrMixin(
            {
                mixinDevice,
                mixinDeviceInterfaces,
                mixinDeviceState,
                mixinProviderNativeId: this.nativeId,
                group: 'NVR Storage',
                groupKey: 'nvr-storage',
            },
            this,
        );
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        (mixinDevice as NvrMixin).dispose();
    }

    /* ---------------- Notifier: the bridge from AI Vision Alerts ---------------- */

    async sendNotification(
        title: string,
        options?: NotifierOptions,
        media?: string | MediaObject,
        icon?: string | MediaObject,
    ): Promise<void> {
        try {
            const d = options?.data;
            if (d && d.source === 'ai-vision-alerts') {
                const meta: Meta = {
                    cameraId: String(d.cameraId ?? ''),
                    cameraName: String(d.cameraName ?? title),
                    severity: d.severity ? String(d.severity) : undefined,
                    summary: d.summary ? String(d.summary) : undefined,
                    reason: 'AI alert',
                };
                const save = String(d.save ?? 'none');

                if ((save === 'snapshot' || save === 'both') && media) {
                    const jpeg = await this.mediaToJpeg(media);
                    await this.saveSnapshot(meta, jpeg);
                }
                if ((save === 'clip' || save === 'both') && meta.cameraId) {
                    const seconds =
                        Number(d.clipSeconds) || this.cameraModes.get(meta.cameraId)?.seconds || 30;
                    await this.requestClip(meta, seconds);
                }
                return;
            }

            if (this.storageSettings.values.saveAnyNotifierImages && media) {
                const jpeg = await this.mediaToJpeg(media);
                await this.saveSnapshot({ cameraId: 'notifier', cameraName: title, reason: 'notification' }, jpeg);
            }
        } catch (e) {
            this.fail('Handling notification failed', e);
        }
    }

    async mediaToJpeg(media: string | MediaObject): Promise<Buffer> {
        const mo = typeof media === 'string' ? await mediaManager.createMediaObjectFromUrl(media) : media;
        return mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
    }

    fail(message: string, e: unknown) {
        this.lastError = `${new Date().toISOString()} ${message}: ${errMsg(e)}`;
        this.console.error(message, e);
    }

    /* ---------------- Staging and clip recording ---------------- */

    async stagingDir(): Promise<string> {
        const custom = String(this.storageSettings.values.stagingPath ?? '').trim();
        const dir = custom || path.join(process.env.SCRYPTED_PLUGIN_VOLUME || os.tmpdir(), 'nvr-staging');
        await fs.mkdir(dir, { recursive: true });
        return dir;
    }

    async cleanStaging() {
        const dir = await this.stagingDir();
        const cutoff = Date.now() - 24 * 3600 * 1000;
        for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
            const p = path.join(dir, name);
            const st = await fs.stat(p).catch(() => null);
            if (st && st.isFile() && st.mtimeMs < cutoff)
                await fs.rm(p, { force: true });
        }
    }

    /** Called by the camera mixin when motion starts. */
    async onMotion(cameraId: string, cameraName: string) {
        const cfg = this.cameraModes.get(cameraId);
        if (!cfg || cfg.mode === 'off')
            return;

        const current = this.staged.get(cameraId);
        if (current && !current.done)
            return; // already recording this event

        await this.startStaging(cameraId, cameraName, cfg.seconds, cfg.mode, false);
    }

    async startStaging(
        cameraId: string,
        cameraName: string,
        seconds: number,
        mode: 'ai' | 'all',
        keep: boolean,
        meta?: Meta,
    ): Promise<Staged> {
        const dir = await this.stagingDir();
        const startedAt = Date.now();
        const s: Staged = {
            cameraId,
            cameraName,
            seconds,
            mode,
            startedAt,
            file: path.join(dir, `${safeName(cameraName)}_${startedAt}.mp4`),
            done: false,
            failed: false,
            keep,
            finalized: false,
            meta,
        };
        this.staged.set(cameraId, s);
        this.recordInto(s).catch(e => this.fail('Clip recording crashed', e));
        return s;
    }

    async recordInto(s: Staged) {
        try {
            const camera = systemManager.getDeviceById<VideoCamera>(s.cameraId);
            if (!camera)
                throw new Error(`Camera ${s.cameraId} not found`);
            const inputArgs = await getCameraInput(camera);
            const ffmpegPath = await mediaManager.getFFmpegPath();
            const args = [
                '-hide_banner', '-loglevel', 'error', '-y',
                ...inputArgs,
                '-t', String(s.seconds),
                '-map', '0:v:0', '-map', '0:a:0?',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '64k',
                '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                '-f', 'mp4',
                s.file,
            ];
            try {
                await runFfmpeg(ffmpegPath, args, (s.seconds + 30) * 1000);
            } catch (e) {
                const st = await fs.stat(s.file).catch(() => null);
                if (!st || st.size < 2000)
                    throw e;
                this.console.warn('ffmpeg ended early but a partial clip exists:', errMsg(e));
            }
        } catch (e) {
            s.failed = true;
            this.fail(`Recording clip for ${s.cameraName} failed`, e);
        }
        s.done = true;

        if (s.failed) {
            await fs.rm(s.file, { force: true });
            if (this.staged.get(s.cameraId) === s)
                this.staged.delete(s.cameraId);
            return;
        }

        if (s.keep || s.mode === 'all') {
            await this.finalizeClip(s);
        } else {
            const grace = Math.max(10, Number(this.storageSettings.values.graceSeconds ?? 90)) * 1000;
            s.timer = setTimeout(() => this.discard(s), grace);
        }
    }

    async discard(s: Staged) {
        if (s.finalized)
            return;
        s.finalized = true;
        if (this.staged.get(s.cameraId) === s)
            this.staged.delete(s.cameraId);
        await fs.rm(s.file, { force: true });
    }

    /** The AI (or a test button) wants a clip saved for this camera. */
    async requestClip(meta: Meta, defaultSeconds: number) {
        const cfg = this.cameraModes.get(meta.cameraId);
        const s = this.staged.get(meta.cameraId);

        if (s && !s.finalized && !s.failed) {
            s.keep = true;
            s.meta = { ...s.meta, ...meta };
            if (s.done) {
                if (s.timer)
                    clearTimeout(s.timer);
                await this.finalizeClip(s);
            }
            return; // still recording: it will be finalized when ffmpeg ends
        }

        if (cfg?.mode === 'all' && meta.reason === 'AI alert')
            return; // every motion clip is already being saved

        await this.startStaging(meta.cameraId, meta.cameraName, defaultSeconds, 'ai', true, meta);
    }

    async makeThumbnail(clip: string, thumb: string): Promise<boolean> {
        const ffmpegPath = await mediaManager.getFFmpegPath();
        for (const ss of ['2', '0']) {
            try {
                await runFfmpeg(
                    ffmpegPath,
                    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', ss, '-i', clip, '-frames:v', '1', '-q:v', '3', thumb],
                    30000,
                );
                if (await exists(thumb))
                    return true;
            } catch {
                // try the next offset
            }
        }
        return false;
    }

    async finalizeClip(s: Staged) {
        if (s.finalized)
            return;
        s.finalized = true;
        if (s.timer)
            clearTimeout(s.timer);
        if (this.staged.get(s.cameraId) === s)
            this.staged.delete(s.cameraId);

        const t = new Date(s.startedAt);
        const meta: Meta = { cameraId: s.cameraId, cameraName: s.cameraName, ...s.meta };
        const sev = meta.severity ? `_${safeName(meta.severity)}` : '';
        const base = `${safeName(s.cameraName)}/${dateFolder(t)}/${timeStamp(t)}_clip${sev}`;

        const thumb = s.file.replace(/\.mp4$/, '.jpg');
        const json = s.file.replace(/\.mp4$/, '.json');
        const haveThumb = await this.makeThumbnail(s.file, thumb);

        await fs.writeFile(
            json,
            JSON.stringify(
                {
                    type: 'clip',
                    camera: s.cameraName,
                    cameraId: s.cameraId,
                    startedAt: t.toISOString(),
                    seconds: s.seconds,
                    severity: meta.severity,
                    summary: meta.summary,
                    reason: meta.reason,
                },
                null,
                2,
            ),
        );

        const items: StoreItem[] = [{ file: s.file, rel: `${base}.mp4` }];
        if (haveThumb)
            items.push({ file: thumb, rel: `${base}.jpg` });
        items.push({ file: json, rel: `${base}.json` });

        const errors = await this.storeAll(items);
        if (errors.length) {
            this.console.warn(`Clip kept in staging because of errors (deleted after 24h): ${s.file}`);
        } else {
            for (const i of items)
                await fs.rm(i.file, { force: true });
            this.console.log(`Saved clip ${base}.mp4`);
        }
    }

    async saveSnapshot(meta: Meta, jpeg: Buffer) {
        const t = new Date();
        const sev = meta.severity ? `_${safeName(meta.severity)}` : '';
        const base = `${safeName(meta.cameraName)}/${dateFolder(t)}/${timeStamp(t)}_snapshot${sev}`;
        const dir = await this.stagingDir();
        const id = `snap_${t.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
        const jpg = path.join(dir, `${id}.jpg`);
        const json = path.join(dir, `${id}.json`);

        await fs.writeFile(jpg, jpeg);
        await fs.writeFile(
            json,
            JSON.stringify(
                {
                    type: 'snapshot',
                    camera: meta.cameraName,
                    cameraId: meta.cameraId,
                    time: t.toISOString(),
                    severity: meta.severity,
                    summary: meta.summary,
                    reason: meta.reason,
                },
                null,
                2,
            ),
        );

        const items: StoreItem[] = [
            { file: jpg, rel: `${base}.jpg` },
            { file: json, rel: `${base}.json` },
        ];
        const errors = await this.storeAll(items);
        if (!errors.length) {
            for (const i of items)
                await fs.rm(i.file, { force: true });
            this.console.log(`Saved snapshot ${base}.jpg`);
        }
    }

    /* ---------------- Destinations ---------------- */

    async storeAll(items: StoreItem[]): Promise<string[]> {
        const v = this.storageSettings.values;
        const targets: [string, (file: string, rel: string) => Promise<void>][] = [];
        if (v.localEnabled)
            targets.push(['local drive', (f, r) => this.storeLocal(f, r)]);
        if (v.dropboxEnabled)
            targets.push(['Dropbox', (f, r) => this.storeDropbox(f, r)]);
        if (v.driveEnabled)
            targets.push(['Google Drive', (f, r) => this.storeDrive(f, r)]);

        if (!targets.length) {
            const msg = 'No storage destination is enabled in the NVR Storage plugin settings.';
            this.fail('Nothing saved', new Error(msg));
            return [msg];
        }

        const errors: string[] = [];
        for (const [name, store] of targets) {
            for (const item of items) {
                try {
                    await withRetry(() => store(item.file, item.rel));
                } catch (e) {
                    const msg = `${name}: ${errMsg(e)}`;
                    errors.push(msg);
                    this.fail(`Saving ${item.rel} failed`, new Error(msg));
                    break; // skip the rest of this destination's files
                }
            }
        }
        return errors;
    }

    localRoot(): { mount: string; root: string } {
        const v = this.storageSettings.values;
        const mount = String(v.mountPath ?? '').trim();
        const folder = safeName(String(v.folderName ?? 'scrypted-nvr'));
        return { mount, root: path.join(mount, folder) };
    }

    async checkLocal() {
        const v = this.storageSettings.values;
        const { mount } = this.localRoot();
        if (!mount)
            throw new NoRetryError('Drive mount path is empty.');
        if (!(await exists(mount)))
            throw new NoRetryError(`Mount path ${mount} does not exist inside the Scrypted add-on.`);
        if (v.requireMarker && !(await exists(path.join(mount, MARKER))))
            throw new NoRetryError(
                `Drive marker ${MARKER} not found in ${mount}. The drive may be unplugged or unmounted. ` +
                'If the drive is mounted, press "Create drive marker" in the plugin settings.',
            );
    }

    async storeLocal(file: string, rel: string) {
        await this.checkLocal();
        const dest = path.join(this.localRoot().root, ...rel.split('/'));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(file, dest);
    }

    async createMarker() {
        const { mount } = this.localRoot();
        if (!(await exists(mount))) {
            this.console.error(`Mount path ${mount} does not exist. Run "Diagnose storage" to find your drive.`);
            return;
        }
        if (!(await isMountPoint(mount))) {
            this.console.error(
                `${mount} is not a separate mounted drive (it is on the same filesystem as its parent folder). ` +
                'Not creating the marker, because recordings would land on the internal disk. ' +
                'If the drive is mounted deeper, or you are sure, create an empty file named ' +
                `${MARKER} in the drive's root yourself.`,
            );
            return;
        }
        await fs.writeFile(path.join(mount, MARKER), `Created by Scrypted NVR Storage on ${new Date().toISOString()}\n`);
        this.console.log(`Marker created in ${mount}. Free space: ${fmtBytes(await freeBytes(mount))}.`);
    }

    async dropboxToken(): Promise<string> {
        const t = this.tokens.dropbox;
        if (t && Date.now() < t.expires - 60_000)
            return t.token;
        const v = this.storageSettings.values;
        if (!v.dropboxAppKey || !v.dropboxAppSecret || !v.dropboxRefreshToken)
            throw new NoRetryError('Dropbox app key, app secret and refresh token are required.');
        const json = await httpJson('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: String(v.dropboxRefreshToken),
                client_id: String(v.dropboxAppKey),
                client_secret: String(v.dropboxAppSecret),
            }),
        });
        this.tokens.dropbox = { token: json.access_token, expires: Date.now() + Number(json.expires_in ?? 14400) * 1000 };
        return json.access_token;
    }

    async storeDropbox(file: string, rel: string) {
        const data = await fs.readFile(file);
        if (data.length > MAX_DROPBOX_BYTES)
            throw new NoRetryError(`File is larger than ${MAX_DROPBOX_BYTES / 1024 / 1024} MB, too big for a single Dropbox upload.`);

        let folder = String(this.storageSettings.values.dropboxFolder ?? '/Scrypted NVR').trim();
        if (!folder.startsWith('/'))
            folder = `/${folder}`;
        folder = folder.replace(/\/+$/, '');

        const arg = JSON.stringify({ path: `${folder}/${rel}`, mode: 'add', autorename: true, mute: true }).replace(
            /[\u007f-\uffff]/g,
            c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );

        try {
            const token = await this.dropboxToken();
            await httpJson(
                'https://content.dropboxapi.com/2/files/upload',
                {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'dropbox-api-arg': arg,
                        'content-type': 'application/octet-stream',
                    },
                    body: new Uint8Array(data),
                },
                120000,
            );
        } catch (e) {
            this.tokens.dropbox = undefined;
            throw e;
        }
    }

    async googleToken(): Promise<string> {
        const t = this.tokens.google;
        if (t && Date.now() < t.expires - 60_000)
            return t.token;
        const v = this.storageSettings.values;
        if (!v.googleClientId || !v.googleClientSecret || !v.googleRefreshToken)
            throw new NoRetryError('Google client ID, client secret and refresh token are required.');
        const json = await httpJson('https://oauth2.googleapis.com/token', {
            method: 'POST',
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: String(v.googleRefreshToken),
                client_id: String(v.googleClientId),
                client_secret: String(v.googleClientSecret),
            }),
        });
        this.tokens.google = { token: json.access_token, expires: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
        return json.access_token;
    }

    async driveFolder(token: string): Promise<string> {
        const configured = String(this.storageSettings.values.driveFolderId ?? '').trim();
        if (configured)
            return configured;
        const saved = this.storage.getItem('driveFolderId');
        if (saved)
            return saved;

        const headers = { authorization: `Bearer ${token}` };
        const q = encodeURIComponent("name='Scrypted NVR' and mimeType='application/vnd.google-apps.folder' and trashed=false");
        const found = await httpJson(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers });
        let id: string | undefined = found.files?.[0]?.id;
        if (!id) {
            const created = await httpJson('https://www.googleapis.com/drive/v3/files?fields=id', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Scrypted NVR', mimeType: 'application/vnd.google-apps.folder' }),
            });
            id = created.id as string;
        }
        this.storage.setItem('driveFolderId', id);
        return id;
    }

    async storeDrive(file: string, rel: string) {
        const data = await fs.readFile(file);
        try {
            const token = await this.googleToken();
            const parent = await this.driveFolder(token);
            const boundary = `scryptednvr${Date.now()}${Math.random().toString(36).slice(2)}`;
            const metadata = JSON.stringify({ name: rel.replace(/\//g, '_'), parents: [parent] });
            const body = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
                Buffer.from(`--${boundary}\r\nContent-Type: ${mimeFor(file)}\r\n\r\n`),
                data,
                Buffer.from(`\r\n--${boundary}--`),
            ]);
            await httpJson(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
                {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'content-type': `multipart/related; boundary=${boundary}`,
                    },
                    body: new Uint8Array(body),
                },
                120000,
            );
        } catch (e) {
            this.tokens.google = undefined;
            this.storage.removeItem('driveFolderId');
            throw e;
        }
    }

    /* ---------------- Retention ---------------- */

    async enforceRetention() {
        const v = this.storageSettings.values;
        if (!v.localEnabled)
            return;
        try {
            await this.checkLocal();
        } catch {
            return; // drive missing: never delete anything
        }

        const { root } = this.localRoot();
        if (!(await exists(root)))
            return;

        const files = await walk(root);
        const removed: string[] = [];
        const remove = async (f: { file: string }) => {
            await fs.rm(f.file, { force: true });
            removed.push(f.file);
        };

        let remaining = files;
        const days = Number(v.retentionDays ?? 0);
        if (days > 0) {
            const cutoff = Date.now() - days * 24 * 3600 * 1000;
            const old = remaining.filter(f => f.mtimeMs < cutoff);
            for (const f of old)
                await remove(f);
            remaining = remaining.filter(f => f.mtimeMs >= cutoff);
        }

        const maxBytes = Number(v.maxSizeGb ?? 0) * 1024 ** 3;
        if (maxBytes > 0) {
            remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
            let total = remaining.reduce((n, f) => n + f.size, 0);
            for (const f of remaining) {
                if (total <= maxBytes)
                    break;
                await remove(f);
                total -= f.size;
            }
        }

        const dirs = new Set(removed.map(f => path.dirname(f)));
        for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
            for (const candidate of [d, path.dirname(d)]) {
                if (candidate !== root && candidate.startsWith(root + path.sep))
                    await fs.rmdir(candidate).catch(() => undefined);
            }
        }

        if (removed.length)
            this.console.log(`Retention removed ${removed.length} file(s).`);
    }

    /* ---------------- Diagnostics ---------------- */

    async diagnose() {
        const lines: string[] = ['Storage diagnosis (paths as seen inside the Scrypted add-on):'];
        for (const p of ['/data', '/media', '/share', '/mnt', '/config', '/backup']) {
            if (!(await exists(p))) {
                lines.push(`  ${p}: not present`);
                continue;
            }
            let writable = true;
            try {
                await fs.access(p, fs.constants.W_OK);
            } catch {
                writable = false;
            }
            const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => null);
            const subs = (entries ?? [])
                .filter(e => e.isDirectory())
                .map(e => e.name)
                .slice(0, 15);
            lines.push(
                `  ${p}: ${writable ? 'writable' : 'read-only'}, free ${fmtBytes(await freeBytes(p))}, ` +
                `folders: ${subs.length ? subs.join(', ') : '(none)'}`,
            );
        }
        const { mount } = this.localRoot();
        lines.push(
            `Configured mount path ${mount}: ` +
            `${(await exists(mount)) ? 'exists' : 'MISSING'}, ` +
            `${(await isMountPoint(mount)) ? 'separate mounted drive' : 'NOT a separate drive'}, ` +
            `marker ${(await exists(path.join(mount, MARKER))) ? 'present' : 'absent'}`,
        );
        this.console.log(lines.join('\n'));
    }

    async statusText(): Promise<string> {
        const v = this.storageSettings.values;
        const parts: string[] = [];
        if (v.localEnabled) {
            try {
                await this.checkLocal();
                const { mount } = this.localRoot();
                parts.push(`Local drive: OK (${fmtBytes(await freeBytes(mount))} free at ${mount})`);
            } catch (e) {
                parts.push(`Local drive: PROBLEM - ${errMsg(e)}`);
            }
        } else {
            parts.push('Local drive: off');
        }
        parts.push(`Dropbox: ${v.dropboxEnabled ? 'on' : 'off'}`);
        parts.push(`Google Drive: ${v.driveEnabled ? 'on' : 'off'}`);
        parts.push(`Clips waiting for an AI decision: ${[...this.staged.values()].filter(s => !s.finalized).length}`);
        parts.push(`Last error: ${this.lastError || 'none'}`);
        return parts.join('\n');
    }

    async testStorage() {
        const dir = await this.stagingDir();
        const file = path.join(dir, `test_${Date.now()}.json`);
        await fs.writeFile(file, JSON.stringify({ test: true, time: new Date().toISOString() }));
        try {
            const errors = await this.storeAll([{ file, rel: `_test/${Date.now()}.json` }]);
            if (errors.length) {
                this.console.error(`Test failed: ${errors.join(' | ')}`);
            } else {
                this.console.log('Test file written to every enabled destination.');
            }
        } finally {
            await fs.rm(file, { force: true });
        }
    }
}
