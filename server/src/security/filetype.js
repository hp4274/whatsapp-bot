/**
 * Does an uploaded file's content match what it claims to be? The browser's
 * Content-Type and the filename are both attacker-chosen, so the first bytes
 * are checked before anything is stored or handed to a parser.
 */

const SIGNATURES = {
    jpeg: [[0xff, 0xd8, 0xff]],
    png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],          // %PDF-
    zip: [[0x50, 0x4b, 0x03, 0x04]],                // xlsx, docx
    ole: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // xls, doc
};

const KIND_BY_MIME = {
    'image/jpeg': ['jpeg'],
    'image/png': ['png'],
    'application/pdf': ['pdf'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
    'application/msword': ['ole'],
};

const KIND_BY_EXT = {
    jpg: ['jpeg'], jpeg: ['jpeg'], png: ['png'], pdf: ['pdf'],
    xlsx: ['zip'], xlsm: ['zip'], docx: ['zip'], xls: ['ole', 'zip'], doc: ['ole'],
    csv: ['text'], txt: ['text'],
};

const starts = (buf, sig) => buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/** Plain text: no NUL byte and no known binary signature in the first 8 KB. */
const isText = (buf) => !buf.subarray(0, 8192).includes(0)
    && !Object.values(SIGNATURES).flat().some((sig) => starts(buf, sig));

function matches(buf, kinds) {
    return kinds.some((kind) => (kind === 'text' ? isText(buf) : SIGNATURES[kind].some((sig) => starts(buf, sig))));
}

/**
 * Null when `buffer` matches its claimed type, else the refusal text.
 * The claim is the MIME type when it is one we know, otherwise the extension.
 * Unknown claims are refused, unless `otherwise` names the kind to expect
 * (imports parse anything that is not Excel as CSV text).
 */
export function fileTypeError(buffer, { mimetype = '', filename = '', otherwise = null } = {}) {
    const ext = String(filename).toLowerCase().split('.').pop();
    const kinds = KIND_BY_MIME[mimetype] ?? KIND_BY_EXT[ext] ?? (otherwise ? [otherwise] : null);
    if (!kinds) return `unsupported file type: ${filename || mimetype}`;
    if (!Buffer.isBuffer(buffer) || !buffer.length) return 'the file is empty';
    return matches(buffer, kinds) ? null : `the file content does not match its type (${filename || mimetype})`;
}

/**
 * Middleware after multer on an import route. By extension only: browsers
 * send all sorts of MIME types for a CSV. Excel must really be Excel, anything
 * else must be plain text, which is what the importers parse it as.
 */
export function checkImport(req, res, next) {
    const problem = req.file && fileTypeError(req.file.buffer, { filename: req.file.originalname, otherwise: 'text' });
    return problem ? res.status(400).json({ errors: [problem] }) : next();
}
