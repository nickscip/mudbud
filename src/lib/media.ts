import { Directory, File, Paths } from "expo-file-system";
import { createId } from "./id";

/** The permanent on-disk home for captured media, under the app's documents dir. */
function mediaDir(): Directory {
  const dir = new Directory(Paths.document, "media");
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

function extFromUri(uri: string, fallback: string): string {
  const match = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(uri);
  return match ? match[1].toLowerCase() : fallback;
}

/**
 * Copy a freshly captured/picked asset out of the OS cache into our permanent
 * documents directory, so it survives app restarts and cache eviction.
 * Returns the new persistent id + local uri.
 */
export async function persistMedia(
  srcUri: string,
  type: "photo" | "video"
): Promise<{ id: string; uri: string }> {
  const id = createId();
  const ext = extFromUri(srcUri, type === "photo" ? "jpg" : "mp4");
  const dest = new File(mediaDir(), `${id}.${ext}`);
  new File(srcUri).copy(dest);
  return { id, uri: dest.uri };
}

/** Best-effort deletion of a media file from disk. */
export async function deleteMediaFile(uri: string): Promise<void> {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // ignore — file may already be gone
  }
}
