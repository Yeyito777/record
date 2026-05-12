import { parentPort, workerData } from "worker_threads";

import { readLocalFileUpload } from "./fileupload";

interface UploadWorkerData {
  path: string;
}

try {
  const data = workerData as UploadWorkerData;
  const upload = readLocalFileUpload(data.path);
  parentPort?.postMessage({ ok: true, upload });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
