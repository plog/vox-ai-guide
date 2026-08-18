import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Installs this very extension onto the remote host of the current window, with no shell,
 * no scp and no network: in a remote window the extension API reads and writes the remote
 * filesystem natively. We rebuild our own .vsix from the installed folder (a .vsix is a
 * plain zip), write it to the remote /tmp, and hand it to VSCode's installer — which, in a
 * remote window, installs a VSIX on the server side.
 *
 * Integrity comes for free: the bytes shipped are the bytes already running locally.
 */

// --- Minimal ZIP writer, stored entries only ------------------------------------------
// Shipping a zip dependency to write one archive would be absurd; the stored (uncompressed)
// format is a handful of fixed headers. Compression is pointless here anyway: the artefact
// lives in /tmp for the duration of one install.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Buffer;
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored, no compression
    local.writeUInt16LE(0, 10); // fixed DOS time/date: reproducible, and nobody reads it
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + e.data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// --- VSIX layout ----------------------------------------------------------------------

/** The installed folder has no [Content_Types].xml — the installer wants one. Static. */
const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>
`;

function walk(dir: string, rel = ''): Entry[] {
  const out: Entry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push(...walk(abs, r));
    } else if (d.isFile()) {
      out.push({ name: r, data: fs.readFileSync(abs) });
    }
  }
  return out;
}

/** Rebuild this extension's .vsix from its installed folder, byte-identical in content. */
export function buildVsix(extensionDir: string): Buffer {
  const entries: Entry[] = [{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') }];
  for (const f of walk(extensionDir)) {
    // The installer expects the manifest at the root and the payload under extension/.
    entries.push(
      f.name === '.vsixmanifest'
        ? { name: 'extension.vsixmanifest', data: f.data }
        : { name: `extension/${f.name}`, data: f.data },
    );
  }
  return zip(entries);
}

// --- The deployment itself ------------------------------------------------------------

export async function deployToRemote(ctx: vscode.ExtensionContext): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws || ws.scheme !== 'vscode-remote') {
    vscode.window.showInformationMessage(
      'Vox AI: open a folder on the remote host first — the install lands next to it.',
    );
    return;
  }

  const version = ctx.extension.packageJSON.version as string;
  const vsix = buildVsix(ctx.extensionPath);

  // Same URI authority as the remote workspace: this write goes to the VM's /tmp.
  const remoteVsix = ws.with({ path: `/tmp/vox-ai-guide-${version}.vsix` });
  await vscode.workspace.fs.writeFile(remoteVsix, vsix);

  // In a remote window, a VSIX install targets the remote server — where we want it.
  await vscode.commands.executeCommand('workbench.extensions.installExtension', remoteVsix);

  const reload = await vscode.window.showInformationMessage(
    `Vox AI: installed on the remote host (${version}).`,
    'Reload window',
  );
  if (reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
