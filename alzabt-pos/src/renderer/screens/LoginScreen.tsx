import { useEffect, useState } from "react";
import type { CashierDto } from "../../shared/ipcContract";
import { call, errorText, pos } from "../api";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

export function LoginScreen({ onLogin }: { onLogin: (c: CashierDto) => void }) {
  const [cashiers, setCashiers] = useState<CashierDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call(pos().listCashiers()).then(setCashiers).catch((e) => setError(errorText(e)));
  }, []);

  const press = (key: (typeof KEYS)[number]) => {
    setError(null);
    if (key === "clear") setPin("");
    else if (key === "back") setPin((p) => p.slice(0, -1));
    else if (pin.length < 8) setPin((p) => p + key);
  };

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      onLogin(await call(pos().login({ cashierId: selected, pin })));
    } catch (e) {
      setError(errorText(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card login">
        <h1>Alzabt POS</h1>
        <p className="muted">Select cashier</p>
        <div className="cashiers">
          {cashiers.map((c) => (
            <button
              key={c.id}
              className={selected === c.id ? "btn big selected" : "btn big"}
              onClick={() => {
                setSelected(c.id);
                setPin("");
                setError(null);
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        {selected && (
          <>
            <div className="pin" aria-label="PIN">
              {pin.length ? "•".repeat(pin.length) : <span className="muted">Enter PIN</span>}
            </div>
            <div className="keypad">
              {KEYS.map((k) => (
                <button key={k} className="btn key" onClick={() => press(k)}>
                  {k === "clear" ? "C" : k === "back" ? "⌫" : k}
                </button>
              ))}
            </div>
            <button className="btn primary big wide" disabled={busy || pin.length < 4} onClick={submit}>
              Log in
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
