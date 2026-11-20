// 会社LP 問い合わせ送信
// 送信先：同一ドメインの受付API（/api/contact）。メール・記録・Slack通知はサーバー側で実行する。
// 旧：uno@ 所有の GAS ウェブアプリ（2026-11 廃止）。

// フォーム送信 → /api/contact へPOST → 成功なら thanks ページへ遷移。
// lp: どのLPからの問い合わせか識別する文字列（例: "brand-start"）。
// 失敗時は例外を投げずに false を返し、画面にメール連絡先を案内する。
export async function submitContactForm(
  form: HTMLFormElement,
  lp: string,
): Promise<boolean> {
  const fd = new FormData(form);
  const data: Record<string, string> = { lp };
  fd.forEach((value, key) => {
    if (key.startsWith("_")) return; // 旧formsubmit用メタ項目（_subject等）は除外
    data[key] = typeof value === "string" ? value : "";
  });

  let ok = false;
  try {
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }

  if (!ok) {
    window.alert(
      "送信できませんでした。お手数ですが、時間をおいて再度お試しいただくか、info@gdesign-partners.co.jp までメールでご連絡ください。",
    );
    return false;
  }

  // thanks ページへ遷移（hidden の _next からパスのみ抽出。無ければトップ）
  const next = form.querySelector<HTMLInputElement>('input[name="_next"]')?.value;
  let dest = "/";
  if (next) {
    try {
      dest = new URL(next).pathname;
    } catch {
      dest = next;
    }
  }
  window.location.href = dest;
  return true;
}
