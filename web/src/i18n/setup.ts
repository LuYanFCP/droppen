/*
 * The setup page (`features/auth/setup-view.tsx`): the first account of a
 * device whose Droppen server has none yet — made by its owner, on a page
 * opened signed in from the device itself (`droppen open`), or
 * with the one-time setup code the server keeps. Kept
 * apart from the main tables and merged under them in `index.ts` (a key the
 * main tables already translate keeps that translation); keys are the English
 * source strings, as everywhere.
 *
 * The rule sentences are the server's own `hint`s for `invalid_account`, word
 * for word, so a refusal the page did not catch first reads in the reader's
 * language too.
 */

export const setupZhCN: Record<string, string> = {
  "setup code": "设置码",
  "confirm password": "再输一次密码",
  "create account and sign in": "创建账号并登录",
  "creating account…": "正在创建账号…",
  "Or create the account on this device, without a code:": "或者不用设置码，直接在这台设备上创建账号：",
  "a setup code is 16 letters and digits, like ABCD-EFGH-JKMN-PQRS": "设置码由 16 个字母和数字组成，形如 ABCD-EFGH-JKMN-PQRS",
  "a user name is 1-32 characters of a-z, 0-9, '.', '_' or '-'": "用户名为 1–32 个字符，只能用 a-z、0-9、「.」「_」或「-」",
  "a password is at least 12 characters long": "密码至少要 12 个字符",
  "a password is at most 256 bytes long": "密码最多 256 字节",
  "a password may not start or end with whitespace": "密码不能以空白字符开头或结尾",
  "a password may not be the user name": "密码不能与用户名相同",
  "that password is one of the most common ones; pick another": "这个密码太常见了，换一个",
  "That is not the setup code this device's server printed. `{{command}} setup-code` on this device shows it again.":
    "这不是这台设备的服务端打印的设置码。在这台设备上运行 `{{command}} setup-code` 可以再看一次。",
  "The first account is made on this device's own page, not through Droppen.": "第一个账号要在这台设备自己的页面上创建，不能经由 Droppen。",
  "This device already has an account.": "这台设备已经有账号了。",
  "Local login is switched off on this device (auth.enabled = false), so there is no account to create here.":
    "这台设备关闭了本地登录（auth.enabled = false），这里没有要创建的账号。",
  "This device's server has no setup code. Restart it to get one, or create the account on this device with `{{command}} user add <name>`.":
    "这台设备的服务端没有设置码。重启服务端即可得到一个，或者在这台设备上用 `{{command}} user add <名字>` 创建账号。",
  "Too many wrong setup codes. Try again in {{seconds}} s.": "错误的设置码太多了，请 {{seconds}} 秒后再试。",
  "Too many wrong setup codes. Wait a little, then try again.": "错误的设置码太多了，请稍等再试。",
  /* settings › security, when local login is switched off */
  "switched off": "已关闭",
  "Local login is switched off on this device (auth.enabled = false), so its page answers anyone who can reach it. To require a login, remove this setting from the server's configuration and restart the server:":
    "这台设备关闭了本地登录（auth.enabled = false），任何能连上它的人都能访问它的页面。要启用登录，从服务端配置里去掉这项设置，再重启服务端：",
  "Then make its first account on this device:": "然后在这台设备上创建它的第一个账号：",
  "Could not ask this device's server about its login.": "无法向这台设备的服务端查询登录状态。",
  /* settings › security, this device's owner while it has no account */
  "no account yet": "还没有账号",
  /* the setup page: nobody signed in, no account yet */
  "This device has no account yet.": "这台设备还没有账号。",
  "This is the Droppen app's own server. In the app's menu-bar menu, choose Open in Browser: it opens this page signed in, and the first account is made there.":
    "这是 Droppen App 自己的服务端。在 App 的菜单栏菜单里选「在浏览器中打开」:它会以已登录的状态打开这个页面,第一个账号就在那里创建。",
  "On this device: open Droppen from the app, or run `{{command}} open` in a terminal — it opens this page signed in.":
    "在这台设备上：从 App 打开 Droppen，或在终端里运行 `{{command}} open`，它会以已登录的状态打开这个页面。",
  "Or create the first account with the one-time setup code this device's server keeps (`{{command}} setup-code` on this device shows it)":
    "或者用这台设备的服务端保存的一次性设置码创建第一个账号（在这台设备上运行 `{{command}} setup-code` 可以看到）",
  "That link was already used or has expired. Run `{{command}} open` on this device again.":
    "这个链接已经用过或已过期。请在这台设备上重新运行 `{{command}} open`。",
  "This device has an account now: sign in.": "这台设备现在已经有账号了，请登录。",
  "That link works only on the device itself, not through Droppen.": "这个链接只能在这台设备本身上使用，不能经由 Droppen。",
  /* the first account, made by this device's owner without the code */
  "You opened this page as this device's owner. This device has no account yet: create one to sign in from other devices; from then on every browser signs in, this one too.":
    "你以这台设备主人的身份打开了这个页面。这台设备还没有账号：创建一个，就能从其它设备登录；从那以后每个浏览器都要登录，包括这一个。",
  "The setup code is needed now. `{{command}} setup-code` on this device shows it, or run `{{command}} open` there again.":
    "现在需要设置码。在这台设备上运行 `{{command}} setup-code` 可以查看，或者在那里重新运行 `{{command}} open`。",
  "That name belongs to the Droppen app's own account on this device. Pick another.": "这个名字已被这台设备上 Droppen App 自己的账号占用，请换一个。",
};

export const setupZhTW: Record<string, string> = {
  "setup code": "設定碼",
  "confirm password": "再輸入一次密碼",
  "create account and sign in": "建立帳號並登入",
  "creating account…": "正在建立帳號…",
  "Or create the account on this device, without a code:": "或者不用設定碼，直接在這台裝置上建立帳號：",
  "a setup code is 16 letters and digits, like ABCD-EFGH-JKMN-PQRS": "設定碼由 16 個字母和數字組成，形如 ABCD-EFGH-JKMN-PQRS",
  "a user name is 1-32 characters of a-z, 0-9, '.', '_' or '-'": "使用者名稱為 1–32 個字元，只能用 a-z、0-9、「.」「_」或「-」",
  "a password is at least 12 characters long": "密碼至少要 12 個字元",
  "a password is at most 256 bytes long": "密碼最多 256 位元組",
  "a password may not start or end with whitespace": "密碼不能以空白字元開頭或結尾",
  "a password may not be the user name": "密碼不能與使用者名稱相同",
  "that password is one of the most common ones; pick another": "這個密碼太常見了，換一個",
  "That is not the setup code this device's server printed. `{{command}} setup-code` on this device shows it again.":
    "這不是這台裝置的伺服器印出的設定碼。在這台裝置上執行 `{{command}} setup-code` 可以再看一次。",
  "The first account is made on this device's own page, not through Droppen.": "第一個帳號要在這台裝置自己的頁面上建立，不能經由 Droppen。",
  "This device already has an account.": "這台裝置已經有帳號了。",
  "Local login is switched off on this device (auth.enabled = false), so there is no account to create here.":
    "這台裝置關閉了本地登入（auth.enabled = false），這裡沒有要建立的帳號。",
  "This device's server has no setup code. Restart it to get one, or create the account on this device with `{{command}} user add <name>`.":
    "這台裝置的伺服器沒有設定碼。重新啟動伺服器即可取得一個，或在這台裝置上用 `{{command}} user add <名字>` 建立帳號。",
  "Too many wrong setup codes. Try again in {{seconds}} s.": "錯誤的設定碼太多了，請 {{seconds}} 秒後再試。",
  "Too many wrong setup codes. Wait a little, then try again.": "錯誤的設定碼太多了，請稍候再試。",
  /* settings › security, when local login is switched off */
  "switched off": "已關閉",
  "Local login is switched off on this device (auth.enabled = false), so its page answers anyone who can reach it. To require a login, remove this setting from the server's configuration and restart the server:":
    "這台裝置關閉了本地登入（auth.enabled = false），任何連得上的人都能存取它的頁面。要啟用登入，從伺服器設定中移除這項設定，再重新啟動伺服器：",
  "Then make its first account on this device:": "然後在這台裝置上建立它的第一個帳號：",
  "Could not ask this device's server about its login.": "無法向這台裝置的伺服器查詢登入狀態。",
  /* settings › security, this device's owner while it has no account */
  "no account yet": "還沒有帳號",
  /* the setup page: nobody signed in, no account yet */
  "This device has no account yet.": "這台裝置還沒有帳號。",
  "This is the Droppen app's own server. In the app's menu-bar menu, choose Open in Browser: it opens this page signed in, and the first account is made there.":
    "這是 Droppen App 自己的伺服器。在 App 的選單列選單中選擇「在瀏覽器中打開」:它會以已登入的狀態開啟這個頁面,第一個帳號就在那裡建立。",
  "On this device: open Droppen from the app, or run `{{command}} open` in a terminal — it opens this page signed in.":
    "在這台裝置上：從 App 開啟 Droppen，或在終端機執行 `{{command}} open`，它會以已登入的狀態開啟這個頁面。",
  "Or create the first account with the one-time setup code this device's server keeps (`{{command}} setup-code` on this device shows it)":
    "或者用這台裝置的伺服器保存的一次性設定碼建立第一個帳號（在這台裝置上執行 `{{command}} setup-code` 可以看到）",
  "That link was already used or has expired. Run `{{command}} open` on this device again.":
    "這個連結已經用過或已過期。請在這台裝置上重新執行 `{{command}} open`。",
  "This device has an account now: sign in.": "這台裝置現在已經有帳號了，請登入。",
  "That link works only on the device itself, not through Droppen.": "這個連結只能在這台裝置本身上使用，不能經由 Droppen。",
  /* the first account, made by this device's owner without the code */
  "You opened this page as this device's owner. This device has no account yet: create one to sign in from other devices; from then on every browser signs in, this one too.":
    "你以這台裝置擁有者的身分開啟了這個頁面。這台裝置還沒有帳號：建立一個，就能從其它裝置登入；從那以後每個瀏覽器都要登入，包括這一個。",
  "The setup code is needed now. `{{command}} setup-code` on this device shows it, or run `{{command}} open` there again.":
    "現在需要設定碼。在這台裝置上執行 `{{command}} setup-code` 可以查看，或在那裡重新執行 `{{command}} open`。",
  "That name belongs to the Droppen app's own account on this device. Pick another.": "這個名稱已被這台裝置上 Droppen App 自己的帳號占用，請換一個。",
};

export const setupJa: Record<string, string> = {
  "setup code": "セットアップコード",
  "confirm password": "パスワード（確認）",
  "create account and sign in": "アカウントを作成してログイン",
  "creating account…": "アカウントを作成中…",
  "Or create the account on this device, without a code:": "または、コードなしでこのデバイス上でアカウントを作成します：",
  "a setup code is 16 letters and digits, like ABCD-EFGH-JKMN-PQRS": "セットアップコードは 16 文字の英数字です（例：ABCD-EFGH-JKMN-PQRS）",
  "a user name is 1-32 characters of a-z, 0-9, '.', '_' or '-'": "ユーザー名は a-z、0-9、「.」「_」「-」からなる 1〜32 文字です",
  "a password is at least 12 characters long": "パスワードは 12 文字以上にしてください",
  "a password is at most 256 bytes long": "パスワードは 256 バイト以内にしてください",
  "a password may not start or end with whitespace": "パスワードの先頭と末尾に空白は使えません",
  "a password may not be the user name": "パスワードをユーザー名と同じにはできません",
  "that password is one of the most common ones; pick another": "よく使われているパスワードです。別のものにしてください",
  "That is not the setup code this device's server printed. `{{command}} setup-code` on this device shows it again.":
    "このデバイスのサーバーが表示したセットアップコードではありません。このデバイスで `{{command}} setup-code` を実行すると、もう一度表示されます。",
  "The first account is made on this device's own page, not through Droppen.": "最初のアカウントは Droppen 経由ではなく、このデバイス自身のページで作成します。",
  "This device already has an account.": "このデバイスにはすでにアカウントがあります。",
  "Local login is switched off on this device (auth.enabled = false), so there is no account to create here.":
    "このデバイスではローカルログインがオフ（auth.enabled = false）のため、ここで作成するアカウントはありません。",
  "This device's server has no setup code. Restart it to get one, or create the account on this device with `{{command}} user add <name>`.":
    "このデバイスのサーバーにはセットアップコードがありません。サーバーを再起動するとコードが発行されます。または、このデバイスで `{{command}} user add <名前>` を実行してアカウントを作成してください。",
  "Too many wrong setup codes. Try again in {{seconds}} s.": "セットアップコードの誤りが多すぎます。{{seconds}} 秒後にもう一度お試しください。",
  "Too many wrong setup codes. Wait a little, then try again.": "セットアップコードの誤りが多すぎます。少し待ってからもう一度お試しください。",
  /* settings › security, when local login is switched off */
  "switched off": "オフ",
  "Local login is switched off on this device (auth.enabled = false), so its page answers anyone who can reach it. To require a login, remove this setting from the server's configuration and restart the server:":
    "このデバイスではローカルログインがオフ（auth.enabled = false）のため、到達できる相手なら誰でもこのページを使えます。ログインを必須にするには、サーバーの設定からこの項目を削除して、サーバーを再起動してください：",
  "Then make its first account on this device:": "次に、このデバイスで最初のアカウントを作成します：",
  "Could not ask this device's server about its login.": "このデバイスのサーバーにログインの状態を問い合わせられませんでした。",
  /* settings › security, this device's owner while it has no account */
  "no account yet": "アカウントはまだありません",
  /* the setup page: nobody signed in, no account yet */
  "This device has no account yet.": "このデバイスにはまだアカウントがありません。",
  "This is the Droppen app's own server. In the app's menu-bar menu, choose Open in Browser: it opens this page signed in, and the first account is made there.":
    "これは Droppen アプリ自身のサーバーです。アプリのメニューバーのメニューで「ブラウザで開く」を選ぶと、ログインした状態でこのページが開きます。最初のアカウントはそこで作成します。",
  "On this device: open Droppen from the app, or run `{{command}} open` in a terminal — it opens this page signed in.":
    "このデバイスで、アプリから Droppen を開くか、ターミナルで `{{command}} open` を実行してください。ログインした状態でこのページが開きます。",
  "Or create the first account with the one-time setup code this device's server keeps (`{{command}} setup-code` on this device shows it)":
    "または、このデバイスのサーバーが保存しているワンタイムのセットアップコードで最初のアカウントを作成します（このデバイスで `{{command}} setup-code` を実行すると表示されます）",
  "That link was already used or has expired. Run `{{command}} open` on this device again.":
    "このリンクは使用済みか、期限切れです。このデバイスでもう一度 `{{command}} open` を実行してください。",
  "This device has an account now: sign in.": "このデバイスにはもうアカウントがあります。ログインしてください。",
  "That link works only on the device itself, not through Droppen.": "このリンクは Droppen 経由では使えず、このデバイス上でのみ使えます。",
  /* the first account, made by this device's owner without the code */
  "You opened this page as this device's owner. This device has no account yet: create one to sign in from other devices; from then on every browser signs in, this one too.":
    "このデバイスの所有者としてこのページを開いています。このデバイスにはまだアカウントがありません。作成すると他のデバイスからログインできるようになり、それ以降はこのブラウザも含め、すべてのブラウザでログインが必要になります。",
  "The setup code is needed now. `{{command}} setup-code` on this device shows it, or run `{{command}} open` there again.":
    "セットアップコードが必要になりました。このデバイスで `{{command}} setup-code` を実行すると表示されます。または、そこでもう一度 `{{command}} open` を実行してください。",
  "That name belongs to the Droppen app's own account on this device. Pick another.": "その名前は、このデバイス上の Droppen アプリ自身のアカウントが使っています。別の名前にしてください。",
};
