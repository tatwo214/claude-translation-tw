// Exact, offline source-text transform for the pinned native main bundle.
// Parent owns ASAR/hash approval, packaging, and dictionary/catalog integration.
// No I/O or execution of the supplied source. No dependency on the evidence file.
// Twelve active entries from native-hardcoded-plan.json; the two native renderer
// projection proposals are deliberately excluded. The session-row replacement
// corrects the plan's accidental returnEe() token to return Ee().
// File consent additionally pins the complete g mapping and retains the original
// message/detail templates for any mode other than exact "read" / "open".

// Explicit additions only; these exports do not grant app or descriptor approval.
export const extraDescriptors = Object.freeze({
  "claudetw.native.literal.cancel": "Cancel",
  "claudetw.native.literal.allow": "Allow",
  "claudetw.native.literal.ok": "OK",
  "claudetw.native.literal.open-system-settings": "Open System Settings",
  "claudetw.native.literal.open-claude-settings": "Open Claude Settings",
  "claudetw.native.literal.file-access-title": "File Access Request",
  "claudetw.native.literal.file-preview-question": "Allow Claude to preview this file?",
  "claudetw.native.literal.file-open-question": "Allow Claude to open this file?",
  "claudetw.native.literal.file-preview-detail": "{path}\n\nThis will allow Claude to preview the file.",
  "claudetw.native.literal.file-open-detail": "{path}\n\nThis will allow Claude to open the file with your default application.",
  "claudetw.native.literal.workspace-disk-full": "Cowork workspace disk full",
  "claudetw.native.literal.workspace-disk-nearly-full": "Cowork's workspace disk is nearly full ({free} free of {total}).",
  "claudetw.native.literal.workspace-cleanup-unavailable": "Working files could not be cleaned up automatically.",
  "claudetw.native.literal.workspace-cleanup-no-candidates": "No working files can be cleaned up automatically. The space is held by sessions that are currently running or belong to other accounts.",
  "claudetw.native.literal.workspace-cleanup-detail": "These are your largest inactive {sessionCount, plural, one {session} other {sessions}}:\n\n{sessionList}\n\nCleaning up will free ~{size} of working files from Claude's workspace. Your session history and output files will remain, but continuing these sessions may result in some unexpected behavior due to missing working files.",
  "claudetw.native.literal.clean-up": "Clean up",
  "claudetw.native.literal.archived-suffix": " (archived)",
  "claudetw.native.literal.cleanup-session-row": "  • {title}{archived} — {size}, last used {relativeTime}",
  "claudetw.native.literal.relative-now": "just now",
  "claudetw.native.literal.relative-one-day": "1 day ago",
  "claudetw.native.literal.relative-days": "{count} days ago",
  "claudetw.native.literal.relative-one-hour": "1 hour ago",
  "claudetw.native.literal.relative-hours": "{count} hours ago",
  "claudetw.native.literal.relative-minutes": "{count} minutes ago",
  "claudetw.native.literal.artifact-run-task-question": "Allow \"{artifact}\" to run a scheduled task?",
  "claudetw.native.literal.artifact-run-task-detail": "The live artifact \"{artifact}\" wants to run the scheduled task \"{task}\".",
  "claudetw.native.literal.run": "Run",
  "claudetw.native.literal.task-dont-ask-again": "Don't ask again for this task",
  "claudetw.native.literal.artifact-connector-question": "Allow \"{artifact}\" to run \"{tool}\"?",
  "claudetw.native.literal.artifact-connector-detail": "The live artifact \"{artifact}\" wants to call the connector tool \"{tool}\", which can modify data. This happened without a click or keypress from you.",
  "claudetw.native.literal.could-not-open-session": "Couldn't open session"
});

export const extraTranslations = Object.freeze({
  "Cancel": "取消",
  "Allow": "允許",
  "OK": "好",
  "Open System Settings": "開啟系統設定",
  "Open Claude Settings": "開啟 Claude 設定",
  "File Access Request": "檔案存取要求",
  "Allow Claude to preview this file?": "允許 Claude 預覽這個檔案嗎？",
  "Allow Claude to open this file?": "允許 Claude 開啟這個檔案嗎？",
  "{path}\n\nThis will allow Claude to preview the file.": "{path}\n\n這將允許 Claude 預覽這個檔案。",
  "{path}\n\nThis will allow Claude to open the file with your default application.": "{path}\n\n這將允許 Claude 使用你的預設應用程式開啟這個檔案。",
  "Cowork workspace disk full": "Cowork 工作區磁碟已滿",
  "Cowork's workspace disk is nearly full ({free} free of {total}).": "Cowork 工作區磁碟即將用盡（總容量 {total}，剩餘 {free}）。",
  "Working files could not be cleaned up automatically.": "無法自動清理工作檔案。",
  "No working files can be cleaned up automatically. The space is held by sessions that are currently running or belong to other accounts.": "沒有可自動清理的工作檔案。空間由仍在執行中或屬於其他帳號的工作階段占用。",
  "These are your largest inactive {sessionCount, plural, one {session} other {sessions}}:\n\n{sessionList}\n\nCleaning up will free ~{size} of working files from Claude's workspace. Your session history and output files will remain, but continuing these sessions may result in some unexpected behavior due to missing working files.": "以下是占用空間最大的閒置{sessionCount, plural, one {工作階段} other {工作階段}}：\n\n{sessionList}\n\n清理後將從 Claude 工作區釋放約 {size} 的工作檔案空間。工作階段紀錄與輸出檔案會保留，但繼續這些工作階段時，可能因缺少工作檔案而出現非預期行為。",
  "Clean up": "清理",
  " (archived)": "（已封存）",
  "  • {title}{archived} — {size}, last used {relativeTime}": "  • {title}{archived} — {size}，上次使用：{relativeTime}",
  "just now": "剛剛",
  "1 day ago": "1 天前",
  "{count} days ago": "{count} 天前",
  "1 hour ago": "1 小時前",
  "{count} hours ago": "{count} 小時前",
  "{count} minutes ago": "{count} 分鐘前",
  "Allow \"{artifact}\" to run a scheduled task?": "允許「{artifact}」執行排程任務嗎？",
  "The live artifact \"{artifact}\" wants to run the scheduled task \"{task}\".": "即時作品「{artifact}」要求執行排程任務「{task}」。",
  "Run": "執行",
  "Don't ask again for this task": "不再詢問這個任務",
  "Allow \"{artifact}\" to run \"{tool}\"?": "允許「{artifact}」執行「{tool}」嗎？",
  "The live artifact \"{artifact}\" wants to call the connector tool \"{tool}\", which can modify data. This happened without a click or keypress from you.": "即時作品「{artifact}」要求呼叫可修改資料的連接器工具「{tool}」。這項要求並非由你的點擊或按鍵操作觸發。",
  "Couldn't open session": "無法開啟工作階段",
  "Services": "服務",
  "Hide Claude": "隱藏 Claude",
  "Hide Others": "隱藏其他",
  "Show All": "顯示全部",
  "Paste and Match Style": "貼上並符合樣式",
  "Minimize": "縮小視窗",
  "Bring All to Front": "全部移至最前面"
});

const patches = [
  {
    "id": "application-menu-roles",
    "needle": "async function eiA(){const e=Or?await M8r():await N8r();return aA.Menu.buildFromTemplate(e)}",
    "replacement": "async function eiA(){const e=Or?await M8r():await N8r();try{const t=require(\"./claudetw-main.cjs\").snapshot();if(Or&&t&&t.schema===2&&t.enabled===true&&t.compatible===true&&t.dictionary&&typeof t.dictionary===\"object\"){const i={\"services\":\"Services\",\"hide\":\"Hide Claude\",\"hideOthers\":\"Hide Others\",\"unhide\":\"Show All\",\"pasteAndMatchStyle\":\"Paste and Match Style\",\"minimize\":\"Minimize\",\"front\":\"Bring All to Front\"};for(const r of [e[0],e[2],e.find(n=>n&&n.role===\"window\")])if(r&&Array.isArray(r.submenu))for(const n of r.submenu)if(n&&Object.prototype.hasOwnProperty.call(i,n.role)){const o=i[n.role];if((n.label===void 0||n.label===o)&&Object.prototype.hasOwnProperty.call(t.dictionary,o)){const a=t.dictionary[o];typeof a===\"string\"&&a.length>0&&a.length<=1000&&(n.label=a)}}}}catch{}return aA.Menu.buildFromTemplate(e)}"
  },
  {
    "id": "microphone-before-use-buttons",
    "needle": "buttons:[\"Open System Settings\",\"Cancel\"]",
    "replacement": "buttons:[Ee().formatMessage({id:\"claudetw.native.literal.open-system-settings\",defaultMessage:\"Open System Settings\"}),Ee().formatMessage({id:\"claudetw.native.literal.cancel\",defaultMessage:\"Cancel\"})]"
  },
  {
    "id": "microphone-hotkey-buttons",
    "needle": "buttons:[\"Open System Settings\",\"Open Claude Settings\",\"Cancel\"]",
    "replacement": "buttons:[Ee().formatMessage({id:\"claudetw.native.literal.open-system-settings\",defaultMessage:\"Open System Settings\"}),Ee().formatMessage({id:\"claudetw.native.literal.open-claude-settings\",defaultMessage:\"Open Claude Settings\"}),Ee().formatMessage({id:\"claudetw.native.literal.cancel\",defaultMessage:\"Cancel\"})]"
  },
  {
    "id": "file-access-consent",
    "needle": "const g=i===\"read\"?\"preview\":\"open\";return(await aA.dialog.showMessageBox(e,{type:\"question\",buttons:[\"Cancel\",\"Allow\"],defaultId:0,cancelId:0,title:\"File Access Request\",message:`Allow Claude to ${g} this file?`,detail:`${t}\n\nThis will allow Claude to ${g} the file${i===\"open\"?\" with your default application\":\"\"}.`}))",
    "replacement": "const g=i===\"read\"?\"preview\":\"open\";return(await aA.dialog.showMessageBox(e,{type:\"question\",buttons:[Ee().formatMessage({id:\"claudetw.native.literal.cancel\",defaultMessage:\"Cancel\"}),Ee().formatMessage({id:\"claudetw.native.literal.allow\",defaultMessage:\"Allow\"})],defaultId:0,cancelId:0,title:Ee().formatMessage({id:\"claudetw.native.literal.file-access-title\",defaultMessage:\"File Access Request\"}),message:i===\"read\"?Ee().formatMessage({id:\"claudetw.native.literal.file-preview-question\",defaultMessage:\"Allow Claude to preview this file?\"}):i===\"open\"?Ee().formatMessage({id:\"claudetw.native.literal.file-open-question\",defaultMessage:\"Allow Claude to open this file?\"}):`Allow Claude to ${g} this file?`,detail:i===\"read\"?Ee().formatMessage({id:\"claudetw.native.literal.file-preview-detail\",defaultMessage:\"{path}\\n\\nThis will allow Claude to preview the file.\"},{path:t}):i===\"open\"?Ee().formatMessage({id:\"claudetw.native.literal.file-open-detail\",defaultMessage:\"{path}\\n\\nThis will allow Claude to open the file with your default application.\"},{path:t}):`${t}\n\nThis will allow Claude to ${g} the file${i===\"open\"?\" with your default application\":\"\"}.`}))"
  },
  {
    "id": "workspace-cleanup-unavailable",
    "needle": "type:\"warning\",title:\"Cowork workspace disk full\",message:`Cowork's workspace disk is nearly full (${nm(i.freeBytes)} free of ${nm(i.totalBytes)}).`,detail:\"Working files could not be cleaned up automatically.\",buttons:[\"OK\"]",
    "replacement": "type:\"warning\",title:Ee().formatMessage({id:\"claudetw.native.literal.workspace-disk-full\",defaultMessage:\"Cowork workspace disk full\"}),message:Ee().formatMessage({id:\"claudetw.native.literal.workspace-disk-nearly-full\",defaultMessage:\"Cowork's workspace disk is nearly full ({free} free of {total}).\"},{free:nm(i.freeBytes),total:nm(i.totalBytes)}),detail:Ee().formatMessage({id:\"claudetw.native.literal.workspace-cleanup-unavailable\",defaultMessage:\"Working files could not be cleaned up automatically.\"}),buttons:[Ee().formatMessage({id:\"claudetw.native.literal.ok\",defaultMessage:\"OK\"})]"
  },
  {
    "id": "workspace-cleanup-no-candidates",
    "needle": "type:\"warning\",title:\"Cowork workspace disk full\",message:`Cowork's workspace disk is nearly full (${nm(i.freeBytes)} free of ${nm(i.totalBytes)}).`,detail:\"No working files can be cleaned up automatically. The space is held by sessions that are currently running or belong to other accounts.\",buttons:[\"OK\"]",
    "replacement": "type:\"warning\",title:Ee().formatMessage({id:\"claudetw.native.literal.workspace-disk-full\",defaultMessage:\"Cowork workspace disk full\"}),message:Ee().formatMessage({id:\"claudetw.native.literal.workspace-disk-nearly-full\",defaultMessage:\"Cowork's workspace disk is nearly full ({free} free of {total}).\"},{free:nm(i.freeBytes),total:nm(i.totalBytes)}),detail:Ee().formatMessage({id:\"claudetw.native.literal.workspace-cleanup-no-candidates\",defaultMessage:\"No working files can be cleaned up automatically. The space is held by sessions that are currently running or belong to other accounts.\"}),buttons:[Ee().formatMessage({id:\"claudetw.native.literal.ok\",defaultMessage:\"OK\"})]"
  },
  {
    "id": "workspace-cleanup-confirm",
    "needle": "type:\"warning\",title:\"Cowork workspace disk full\",message:`Cowork's workspace disk is nearly full (${nm(i.freeBytes)} free of ${nm(i.totalBytes)}).`,detail:`These are your largest inactive ${g}:\n\n${a}\n\nCleaning up will free ~${nm(s)} of working files from Claude's workspace. Your session history and output files will remain, but continuing these sessions may result in some unexpected behavior due to missing working files.`,buttons:[\"Clean up\",\"Cancel\"],defaultId:1,cancelId:1",
    "replacement": "type:\"warning\",title:Ee().formatMessage({id:\"claudetw.native.literal.workspace-disk-full\",defaultMessage:\"Cowork workspace disk full\"}),message:Ee().formatMessage({id:\"claudetw.native.literal.workspace-disk-nearly-full\",defaultMessage:\"Cowork's workspace disk is nearly full ({free} free of {total}).\"},{free:nm(i.freeBytes),total:nm(i.totalBytes)}),detail:Ee().formatMessage({id:\"claudetw.native.literal.workspace-cleanup-detail\",defaultMessage:\"These are your largest inactive {sessionCount, plural, one {session} other {sessions}}:\\n\\n{sessionList}\\n\\nCleaning up will free ~{size} of working files from Claude's workspace. Your session history and output files will remain, but continuing these sessions may result in some unexpected behavior due to missing working files.\"},{sessionCount:o.length,sessionList:a,size:nm(s)}),buttons:[Ee().formatMessage({id:\"claudetw.native.literal.clean-up\",defaultMessage:\"Clean up\"}),Ee().formatMessage({id:\"claudetw.native.literal.cancel\",defaultMessage:\"Cancel\"})],defaultId:1,cancelId:1"
  },
  {
    "id": "workspace-session-row",
    "needle": "a=o.map(u=>{const d=u.archived?\" (archived)\":\"\",B=AGr(r-u.modTime);return`  • ${u.title}${d} — ${nm(u.sizeBytes)}, last used ${B}`})",
    "replacement": "a=o.map(u=>{const d=u.archived?Ee().formatMessage({id:\"claudetw.native.literal.archived-suffix\",defaultMessage:\" (archived)\"}):\"\",B=AGr(r-u.modTime);return Ee().formatMessage({id:\"claudetw.native.literal.cleanup-session-row\",defaultMessage:\"  • {title}{archived} — {size}, last used {relativeTime}\"},{title:u.title,archived:d,size:nm(u.sizeBytes),relativeTime:B})})"
  },
  {
    "id": "workspace-relative-time",
    "needle": "function AGr(e){if(e<0)return\"just now\";const A=Math.floor(e/86400);if(A>=1)return A===1?\"1 day ago\":`${A} days ago`;const t=Math.floor(e/3600);if(t>=1)return t===1?\"1 hour ago\":`${t} hours ago`;const i=Math.floor(e/60);return i<=1?\"just now\":`${i} minutes ago`}",
    "replacement": "function AGr(e){if(e<0)return Ee().formatMessage({id:\"claudetw.native.literal.relative-now\",defaultMessage:\"just now\"});const A=Math.floor(e/86400);if(A>=1)return A===1?Ee().formatMessage({id:\"claudetw.native.literal.relative-one-day\",defaultMessage:\"1 day ago\"}):Ee().formatMessage({id:\"claudetw.native.literal.relative-days\",defaultMessage:\"{count} days ago\"},{count:A});const t=Math.floor(e/3600);if(t>=1)return t===1?Ee().formatMessage({id:\"claudetw.native.literal.relative-one-hour\",defaultMessage:\"1 hour ago\"}):Ee().formatMessage({id:\"claudetw.native.literal.relative-hours\",defaultMessage:\"{count} hours ago\"},{count:t});const i=Math.floor(e/60);return i<=1?Ee().formatMessage({id:\"claudetw.native.literal.relative-now\",defaultMessage:\"just now\"}):Ee().formatMessage({id:\"claudetw.native.literal.relative-minutes\",defaultMessage:\"{count} minutes ago\"},{count:i})}"
  },
  {
    "id": "artifact-run-scheduled-task",
    "needle": "r={type:\"question\",message:`Allow \"${i}\" to run a scheduled task?`,detail:`The live artifact \"${i}\" wants to run the scheduled task \"${A}\".`,buttons:[\"Run\",\"Cancel\"],defaultId:1,cancelId:1,checkboxLabel:\"Don't ask again for this task\",checkboxChecked:!1}",
    "replacement": "r={type:\"question\",message:Ee().formatMessage({id:\"claudetw.native.literal.artifact-run-task-question\",defaultMessage:\"Allow \\\"{artifact}\\\" to run a scheduled task?\"},{artifact:i}),detail:Ee().formatMessage({id:\"claudetw.native.literal.artifact-run-task-detail\",defaultMessage:\"The live artifact \\\"{artifact}\\\" wants to run the scheduled task \\\"{task}\\\".\"},{artifact:i,task:A}),buttons:[Ee().formatMessage({id:\"claudetw.native.literal.run\",defaultMessage:\"Run\"}),Ee().formatMessage({id:\"claudetw.native.literal.cancel\",defaultMessage:\"Cancel\"})],defaultId:1,cancelId:1,checkboxLabel:Ee().formatMessage({id:\"claudetw.native.literal.task-dont-ask-again\",defaultMessage:\"Don't ask again for this task\"}),checkboxChecked:!1}"
  },
  {
    "id": "artifact-connector-consent",
    "needle": "r={type:\"warning\",message:`Allow \"${t}\" to run \"${A}\"?`,detail:`The live artifact \"${t}\" wants to call the connector tool \"${A}\", which can modify data. This happened without a click or keypress from you.`,buttons:[\"Allow\",\"Cancel\"],defaultId:1,cancelId:1}",
    "replacement": "r={type:\"warning\",message:Ee().formatMessage({id:\"claudetw.native.literal.artifact-connector-question\",defaultMessage:\"Allow \\\"{artifact}\\\" to run \\\"{tool}\\\"?\"},{artifact:t,tool:A}),detail:Ee().formatMessage({id:\"claudetw.native.literal.artifact-connector-detail\",defaultMessage:\"The live artifact \\\"{artifact}\\\" wants to call the connector tool \\\"{tool}\\\", which can modify data. This happened without a click or keypress from you.\"},{artifact:t,tool:A}),buttons:[Ee().formatMessage({id:\"claudetw.native.literal.allow\",defaultMessage:\"Allow\"}),Ee().formatMessage({id:\"claudetw.native.literal.cancel\",defaultMessage:\"Cancel\"})],defaultId:1,cancelId:1}"
  },
  {
    "id": "resume-session-error-title",
    "needle": "aA.dialog.showErrorBox(\"Couldn't open session\",s instanceof Error?s.message:String(s))",
    "replacement": "aA.dialog.showErrorBox(Ee().formatMessage({id:\"claudetw.native.literal.could-not-open-session\",defaultMessage:\"Couldn't open session\"}),s instanceof Error?s.message:String(s))"
  }
];

/**
 * Return patched source only if EVERY active exact needle occurs exactly once.
 * Missing, duplicated, drifted, or already-patched input fails closed. Renderer
 * locale projection is neither required nor applied. Unrelated bytes survive.
 * Caller must separately enforce the approved application/source hash.
 */
export function applyNativePatches(main) {
  if (typeof main !== 'string') {
    throw new TypeError('Native patches require a source string');
  }
  // Preflight all positions against the original input, before constructing output.
  const spans = patches.map(({ id, needle, replacement }) => {
    const start = main.indexOf(needle);
    if (start < 0) throw new Error('Native patch needle missing: ' + id);
    if (main.indexOf(needle, start + 1) !== -1) {
      throw new Error('Native patch needle is not unique: ' + id);
    }
    return { id, start, end: start + needle.length, replacement };
  }).sort((a, b) => a.start - b.start);

  let result = '', cursor = 0;
  for (const { id, start, end, replacement } of spans) {
    if (start < cursor) throw new Error('Native patch needles overlap: ' + id);
    // Slicing avoids replacement-string metacharacter interpretation ($&, $', ...).
    result += main.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + main.slice(cursor);
}
