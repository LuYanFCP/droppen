/*
 * Several devices on one page (`docs/local-aggregator.md` §6.5, §6.7 M-2):
 * the device a pane, a new session or the settings are about, and a page of
 * a device that is not here. Kept apart from the main tables and merged
 * under them in `index.ts` (a key the main tables already translate keeps
 * that translation); keys are the English source strings, as everywhere.
 * The interface says 「设备」 / 裝置 / デバイス, never 「机器」 or 「电脑」.
 */

export const crossDeviceZhCN: Record<string, string> = {
  "Screens are kept on the main device, which is the same on all your devices: with {{new}} as the main device, the screens on {{old}} are out of sight on all of them until you switch back to {{old}}.": "屏幕布局存在主设备上，这一设置对你的所有设备生效：换成 {{new}} 后，你的每台设备上都会暂时看不到 {{old}} 上的屏幕，换回 {{old}} 即可恢复。",
  "This pane is on another of your devices. Open this screen on droppen.app to see it.": "这个窗格属于你的另一台设备。在 droppen.app 上打开这个屏幕即可看到。",
  "this pane could not be drawn": "这个窗格无法显示",
  "Font size and language follow the main device: change them in its settings.": "字号和语言跟随主设备，在主设备的设置里改。",
  "main device settings": "主设备的设置",
  "main device": "主设备",
  "set as main device": "设为主设备",
  "The main device keeps your screens and layouts.": "主设备保存你的屏幕与布局。",
  "device": "设备",
  "this device is not on this page": "这台设备不在本页",
  "It may have been removed from the account, or the link is from another account.": "它可能已从账户中移除，或者这个链接来自另一个账户。",
  "offline — a new session needs it online": "离线 — 新建会话需要它在线",
  "waiting for another of your devices to confirm": "等待你的另一台设备确认",
  "this device does not accept control from this browser": "这台设备不接受这个浏览器的控制",
  "on this device: {{name}}": "所在设备：{{name}}",
  "The device that keeps this screen runs an older Droppen and cannot keep panes of other devices: they went back to it. Update it, then choose them again.":
    "保存这个屏幕的设备上 Droppen 版本较旧，存不下其它设备的窗格，这些窗格已回到它自己。升级它之后再重新选择。",
  // The local app showing other devices through its gateway (S1-7, features/gateway, the sessions list).
  "read-only here: this session is on another device": "只读：这个会话在另一台设备上",
  "there is no copy of this session on this device yet": "这台设备上还没有这个会话的副本",
  "this needs that device itself — its sessions are read-only here": "这需要那台设备本身——它的会话在这里只读",
  "show the sessions of": "显示哪些设备的会话",
  "every device": "全部",
  "read-only here: these sessions are on another device": "只读：这些会话在另一台设备上",
  "read-only here: start new sessions on that device itself": "在这里只读：请在那台设备上新建会话",
  "read-only here": "在这里只读",
};

export const crossDeviceZhTW: Record<string, string> = {
  "Screens are kept on the main device, which is the same on all your devices: with {{new}} as the main device, the screens on {{old}} are out of sight on all of them until you switch back to {{old}}.": "螢幕版面存在主裝置上，這項設定對你的所有裝置生效：換成 {{new}} 後，你的每台裝置上都會暫時看不到 {{old}} 上的螢幕，換回 {{old}} 即可恢復。",
  "This pane is on another of your devices. Open this screen on droppen.app to see it.": "這個窗格屬於你的另一台裝置。在 droppen.app 上開啟這個螢幕即可看到。",
  "this pane could not be drawn": "這個窗格無法顯示",
  "Font size and language follow the main device: change them in its settings.": "字級和語言跟隨主裝置，在主裝置的設定裡改。",
  "main device settings": "主裝置的設定",
  "main device": "主裝置",
  "set as main device": "設為主裝置",
  "The main device keeps your screens and layouts.": "主裝置保存你的螢幕與版面。",
  "device": "裝置",
  "this device is not on this page": "這台裝置不在此頁",
  "It may have been removed from the account, or the link is from another account.": "它可能已從帳戶中移除，或者這個連結來自另一個帳戶。",
  "offline — a new session needs it online": "離線 — 新增工作階段需要它在線",
  "waiting for another of your devices to confirm": "等待你的另一台裝置確認",
  "this device does not accept control from this browser": "這台裝置不接受這個瀏覽器的控制",
  "on this device: {{name}}": "所在裝置：{{name}}",
  "The device that keeps this screen runs an older Droppen and cannot keep panes of other devices: they went back to it. Update it, then choose them again.":
    "保存這個螢幕的裝置上 Droppen 版本較舊，存不下其他裝置的窗格，這些窗格已回到它自己。升級它之後再重新選擇。",
  // The local app showing other devices through its gateway (S1-7, features/gateway, the sessions list).
  "read-only here: this session is on another device": "唯讀：這個工作階段在另一台裝置上",
  "there is no copy of this session on this device yet": "這台裝置上還沒有這個工作階段的副本",
  "this needs that device itself — its sessions are read-only here": "這需要那台裝置本身——它的工作階段在這裡唯讀",
  "show the sessions of": "顯示哪些裝置的工作階段",
  "every device": "全部",
  "read-only here: these sessions are on another device": "唯讀：這些工作階段在另一台裝置上",
  "read-only here: start new sessions on that device itself": "在這裡唯讀：請在那台裝置上新增工作階段",
  "read-only here": "在這裡唯讀",
};

export const crossDeviceJa: Record<string, string> = {
  "Screens are kept on the main device, which is the same on all your devices: with {{new}} as the main device, the screens on {{old}} are out of sight on all of them until you switch back to {{old}}.": "スクリーンのレイアウトはメインデバイスに保存され、この設定はすべてのデバイスに適用されます。{{new}} をメインデバイスにすると、どのデバイスからも {{old}} のスクリーンは見えなくなり、{{old}} に戻すと元に戻ります。",
  "This pane is on another of your devices. Open this screen on droppen.app to see it.": "このペインは別のデバイスのものです。droppen.app でこのスクリーンを開くと表示されます。",
  "this pane could not be drawn": "このペインを表示できません",
  "Font size and language follow the main device: change them in its settings.": "文字サイズと言語はメインデバイスに従います。メインデバイスの設定で変更してください。",
  "main device settings": "メインデバイスの設定",
  "main device": "メインデバイス",
  "set as main device": "メインデバイスにする",
  "The main device keeps your screens and layouts.": "メインデバイスにスクリーンとレイアウトが保存されます。",
  "device": "デバイス",
  "this device is not on this page": "このデバイスはこのページにありません",
  "It may have been removed from the account, or the link is from another account.": "アカウントから削除されたか、別のアカウントのリンクです。",
  "offline — a new session needs it online": "オフライン — 新しいセッションにはオンラインである必要があります",
  "waiting for another of your devices to confirm": "別のデバイスでの確認を待っています",
  "this device does not accept control from this browser": "このデバイスはこのブラウザーからの操作を受け付けていません",
  "on this device: {{name}}": "デバイス：{{name}}",
  "The device that keeps this screen runs an older Droppen and cannot keep panes of other devices: they went back to it. Update it, then choose them again.":
    "このスクリーンを保存しているデバイスの Droppen が古いため、他のデバイスのペインを保存できません。ペインはそのデバイスに戻りました。更新してから選び直してください。",
  // The local app showing other devices through its gateway (S1-7, features/gateway, the sessions list).
  "read-only here: this session is on another device": "読み取り専用：このセッションは別のデバイスにあります",
  "there is no copy of this session on this device yet": "このデバイスにはまだこのセッションのコピーがありません",
  "this needs that device itself — its sessions are read-only here": "そのデバイス自体が必要です——ここではそのセッションは読み取り専用です",
  "show the sessions of": "表示するデバイスのセッション",
  "every device": "すべて",
  "read-only here: these sessions are on another device": "読み取り専用：これらのセッションは別のデバイスにあります",
  "read-only here: start new sessions on that device itself": "ここでは読み取り専用：新しいセッションはそのデバイスで始めてください",
  "read-only here": "ここでは読み取り専用",
};
