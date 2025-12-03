// @ts-nocheck

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  vus: __ENV.VUS ? Number(__ENV.VUS) : 10,
  duration: __ENV.DURATION || "1m",
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

function mockPayload(task) {
  return {
    task_id: (task && task.task_id) || "mock-task",
    assignment_id: (task && task.assignment_id) || "mock-assign",
    payload: { approved: true },
    duration_ms: 12000,
    playback_ratio: 0.92,
  };
}

}

export default function () {
  const peek = http.get(`${BASE_URL}/api/mobile/peek`);
  check(peek, { "peek ok": (res) => res.status === 200 });

  const bundle = http.get(`${BASE_URL}/api/mobile/bundle?count=1`);
  check(bundle, { "bundle ok": (res) => res.status === 200 });
  const task =
    bundle.status === 200 ? bundle.json("tasks[0]") : undefined;

  const submit = http.post(
    `${BASE_URL}/api/mobile/tasks/submit`,
    JSON.stringify(mockPayload(task)),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${__ITER}-${__VU}-${Date.now()}`,
      },
    }
  );
  check(submit, { "submit ok": (res) => res.status === 200 });

  sleep(1);
}
