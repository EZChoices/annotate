import { getServiceSupabase } from "../supabaseServer";

const BUCKET = process.env.MOBILE_ANNOTATION_BUCKET;
const BASE_PATH = process.env.MOBILE_ANNOTATION_PREFIX || "annotations";

export async function persistAnnotationPayload(options: {
  clipId: string | null;
  taskId: string;
  taskType: string;
  contributorId: string;
  payload: any;
}) {
  if (!BUCKET || !options.clipId) return;
  try {
    const supabase = getServiceSupabase();
    const safeClip = options.clipId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeType = options.taskType.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = `${BASE_PATH}/${safeClip}/${safeType}/${options.taskId}.json`;
    const body = JSON.stringify(
      {
        clip_id: options.clipId,
        task_id: options.taskId,
        task_type: options.taskType,
        contributor_id: options.contributorId,
        payload: options.payload,
        saved_at: new Date().toISOString(),
      },
      null,
      2
    );
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, body, {
        cacheControl: "3600",
        upsert: true,
        contentType: "application/json",
      });
    if (error) {
      console.warn("[mobile] failed to persist annotation payload", error);
    }
  } catch (error) {
    console.warn("[mobile] persistAnnotationPayload threw", error);
  }
}

