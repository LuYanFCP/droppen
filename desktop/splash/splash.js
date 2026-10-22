// The start-up page: asks the app how starting Droppen on this device is
// going, and offers a retry and the logs if it failed. Only this bundled page
// may call these commands (capabilities/main.json).
(function () {
  "use strict";
  var TEXT = {
    "zh-CN": {
      starting: "正在这台设备上启动 Droppen…",
      restarting: "正在重新启动 Droppen…",
      failed: "Droppen 在这台设备上遇到了问题。",
      retry: "重试",
      logs: "打开日志",
    },
    "zh-TW": {
      starting: "正在這台裝置上啟動 Droppen…",
      restarting: "正在重新啟動 Droppen…",
      failed: "Droppen 在這台裝置上遇到了問題。",
      retry: "重試",
      logs: "打開日誌",
    },
    ja: {
      starting: "このデバイスで Droppen を起動しています…",
      restarting: "Droppen を再起動しています…",
      failed: "このデバイスで Droppen に問題が発生しました。",
      retry: "再試行",
      logs: "ログを開く",
    },
    en: {
      starting: "Starting Droppen on this device…",
      restarting: "Restarting Droppen…",
      failed: "Droppen ran into a problem on this device.",
      retry: "Try again",
      logs: "Open logs",
    },
  };
  var lang = (navigator.language || "en").toLowerCase();
  var key = /^zh/.test(lang) ? (/tw|hk|mo|hant/.test(lang) ? "zh-TW" : "zh-CN") : /^ja/.test(lang) ? "ja" : "en";
  var t = TEXT[key];
  document.documentElement.lang = key;

  var status = document.getElementById("status");
  var detail = document.getElementById("detail");
  var actions = document.getElementById("actions");
  var retry = document.getElementById("retry");
  var logs = document.getElementById("logs");
  retry.textContent = t.retry;
  logs.textContent = t.logs;
  status.textContent = t.starting;

  function invoke(command) {
    var ipc = window.__TAURI_INTERNALS__;
    return ipc ? ipc.invoke(command) : Promise.reject(new Error("no IPC"));
  }

  function show(state) {
    var failed = state && state.phase === "failed";
    status.textContent = failed ? t.failed : state && state.phase === "restarting" ? t.restarting : t.starting;
    detail.hidden = !failed;
    detail.textContent = failed ? state.message || "" : "";
    actions.hidden = !failed;
  }

  function poll() {
    invoke("startup_status")
      .then(show)
      .catch(function () {})
      .then(function () {
        setTimeout(poll, 700);
      });
  }

  retry.addEventListener("click", function () {
    show({ phase: "starting" });
    invoke("retry_start").catch(function () {});
  });
  logs.addEventListener("click", function () {
    invoke("open_logs").catch(function () {});
  });
  poll();
})();
