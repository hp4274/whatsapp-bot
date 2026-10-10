/**
 * In-memory media registry that falls back to server/uploads, so a campaign
 * queued before a restart can still resolve its attachment.
 * Files are stored as `${mediaId}_${filename}`; `${mediaId}.tenant` records the
 * owning tenant so one tenant cannot resolve another's upload by id. Files
 * without that record predate it and stay readable.
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.mp4': 'video/mp4', '.3gp': 'video/3gpp',
};

export class MediaStore extends Map {
    constructor(uploadDir, tenantId = null) {
        super();
        this.uploadDir = uploadDir;
        this.tenantId = tenantId;
    }

    /** Record who uploaded `mediaId`. */
    claim(mediaId) {
        if (this.tenantId === null || this.tenantId === undefined) return;
        fs.writeFileSync(path.join(this.uploadDir, `${mediaId}.tenant`), String(this.tenantId));
    }

    #ownedElsewhere(mediaId) {
        if (this.tenantId === null || this.tenantId === undefined) return false;
        try {
            return fs.readFileSync(path.join(this.uploadDir, `${mediaId}.tenant`), 'utf8').trim() !== String(this.tenantId);
        } catch {
            return false; // no record: an upload from before ownership was tracked
        }
    }

    get(mediaId) {
        const hit = super.get(mediaId);
        if (hit || typeof mediaId !== 'string' || !/^med_[a-f0-9]{12}$/.test(mediaId)) return hit;
        if (this.#ownedElsewhere(mediaId)) return undefined;
        try {
            const stored = fs.readdirSync(this.uploadDir).find((name) => name.startsWith(`${mediaId}_`));
            if (!stored) return undefined;
            const filePath = path.join(this.uploadDir, stored);
            const buffer = fs.readFileSync(filePath);
            const media = {
                mediaId,
                filename: stored.slice(mediaId.length + 1),
                mimetype: MIME[path.extname(stored).toLowerCase()] ?? 'application/octet-stream',
                size: buffer.length,
                filePath,
                buffer,
                url: `/api/media/${mediaId}`,
            };
            this.set(mediaId, media);
            return media;
        } catch {
            return undefined;
        }
    }
}
