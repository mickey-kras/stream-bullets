import { useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { intlLocale, t, tn, type MessageId } from "../../i18n";
import type { AlertControl } from "../../lib/alert-control";
import {
  ALERT_MIN,
  ALERT_RULES,
  DEFAULT_TEST_ALERT,
  RULE_ACTIONS,
  TEST_ALERTS,
  hasThreshold,
  testSupport,
  type AlertAction,
  type AlertKind,
  type AlertRule,
  type AlertRuleId,
  type AlertRules,
  type TestAlert,
} from "../../lib/alerts";
import { ApiError, errorMessage } from "../api";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import { ALERT_ICONS } from "./alerts-layer";
import { ControlApiContext, type ControlApi } from "./control-api";
import { SAVE_IDLE_MS, usePendingField, type EditTiming } from "./use-layer-draft";

/**
 * False until the server makes the alert of a featured topic (issue #1043, the topic credit). The rules table then
 * has no `topic` row, and the test list has no topic test: the owner cannot change a rule that never plays.
 */
export const TOPIC_CREDITS_READY: boolean = false;

/** The rules that the table shows, in the sequence of ALERT_RULES. */
export function shownRules(topic: boolean = TOPIC_CREDITS_READY): readonly AlertRuleId[] {
  return ALERT_RULES.filter((rule: AlertRuleId): boolean => topic || rule !== "topic");
}

/** The test alerts that the list offers, in the sequence of TEST_ALERTS. */
export function shownTests(topic: boolean = TOPIC_CREDITS_READY): readonly TestAlert[] {
  return TEST_ALERTS.filter((test: TestAlert): boolean => topic || test !== "topic");
}

function isTestAlert(value: string): value is TestAlert {
  const tests: readonly string[] = TEST_ALERTS;
  return tests.includes(value);
}

const RULE_NAMES: Readonly<Record<AlertRuleId, MessageId>> = {
  follow: "overlay.alerts.rule.follow",
  subscription: "overlay.alerts.rule.subscription",
  gift: "overlay.alerts.rule.gift",
  bits: "overlay.alerts.rule.bits",
  paid: "overlay.alerts.rule.paid",
  raid: "overlay.alerts.rule.raid",
  topic: "overlay.alerts.rule.topic",
};

/** The line under the name of a rule: the platforms of the rule, or how it counts. */
const RULE_NOTES: Readonly<Record<AlertRuleId, MessageId>> = {
  follow: "overlay.alerts.ruleNote.follow",
  subscription: "overlay.alerts.ruleNote.subscription",
  gift: "overlay.alerts.ruleNote.gift",
  bits: "overlay.alerts.ruleNote.bits",
  paid: "overlay.alerts.ruleNote.paid",
  raid: "overlay.alerts.ruleNote.raid",
  topic: "overlay.alerts.ruleNote.topic",
};

/** The icon of each rule: the icon of its first kind on the banner (ALERT_ICONS). */
const RULE_KINDS: Readonly<Record<AlertRuleId, AlertKind>> = {
  follow: "follow",
  subscription: "subscription",
  gift: "gift",
  bits: "bits",
  paid: "super_chat",
  raid: "raid",
  topic: "topic",
};

const ACTION_NAMES: Readonly<Record<AlertAction, MessageId>> = {
  wave: "overlay.alerts.action.wave",
  jump: "overlay.alerts.action.jump",
  crowd: "overlay.alerts.action.crowd",
};

/** The name of a test alert in the list. The amounts are those of the sample that the server plays. */
export function testName(test: TestAlert): string {
  const amount: number = testSupport(test, 0, 0).amount ?? 0;
  switch (test) {
    case "follow":
      return t("overlay.alerts.testKind.follow");
    case "subscription":
      return t("overlay.alerts.testKind.subscription");
    case "gift":
      return tn("overlay.alerts.testKind.gift", amount);
    case "bits":
      return tn("tools.live.support.bits", amount);
    case "super_chat":
      return t("overlay.alerts.testKind.superChat");
    case "raid":
      return tn("overlay.alerts.testKind.raid", amount);
    case "topic":
      return t("overlay.alerts.rule.topic");
    case "anonymous":
      return t("overlay.alerts.testKind.anonymous");
  }
}

/**
 * The text for a failed request of the alert controls. The API codes of the alert host have their own text (see
 * `codeMessages` in app/components/api.ts). A 503 without a code: the server has no alerts.
 */
export function alertsFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 503 && error.code === null) return t("overlay.alerts.off");
  return errorMessage(error);
}

/** A whole number as typed: in the limits, or null. */
export function parseWholeNumber(text: string, limits: Readonly<{ min: number; max: number }>): number | null {
  const trimmed: string = text.trim();
  if (!/^\d{1,8}$/.test(trimmed)) return null;
  const value: number = Number(trimmed);
  return value >= limits.min && value <= limits.max ? value : null;
}

/**
 * A field for a whole number in `limits`. The text is valid when the owner stops typing for SAVE_IDLE_MS or leaves
 * the field: then the value saves (`onValue` with "now"). Text that becomes invalid cancels the value that waits, so
 * a value typed on the way, such as 2 when 25 is cleared, never saves. The field tells the limits when the focus
 * leaves it with invalid text. A value that waits when the field goes away, or when the owner leaves the page or closes
 * the editor, goes with the edits that the editor sends then.
 */
export function WholeNumberInput({
  value,
  limits,
  label,
  labelledBy,
  onValue,
  ...data
}: Readonly<{
  value: number;
  limits: Readonly<{ min: number; max: number }>;
  /** The accessible name, when no visible label names the field. */
  label?: string;
  labelledBy?: string;
  onValue: (value: number, when: EditTiming) => void;
  [key: `data-${string}`]: boolean;
}>): ReactNode {
  const errorId: string = useId();
  // Null shows the saved value; a string is the text of the owner.
  const [text, setText] = useState<string | null>(null);
  // The error shows after the focus left the field, not while the owner types.
  const [left, setLeft] = useState<boolean>(false);
  const invalid: boolean = left && text !== null && parseWholeNumber(text, limits) === null;
  const numbers = new Intl.NumberFormat(intlLocale());
  // The valid value that waits for the pause, and its timer.
  const waiting = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useRef<(value: number, when: EditTiming) => void>(onValue);
  useEffect(() => {
    send.current = onValue;
  }, [onValue]);
  const stop = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const give = useCallback(
    (when: EditTiming): void => {
      stop();
      const next: number | null = waiting.current;
      waiting.current = null;
      if (next !== null) send.current(next, when);
    },
    [stop],
  );
  const commit = useCallback((): void => give("now"), [give]);
  // The editor's own save of the edits not sent yet takes the value when the page or the editor goes away.
  usePendingField(useCallback((): void => give("idle"), [give]));
  // A value that waits saves when the field goes away.
  useEffect(() => commit, [commit]);
  return (
    <span className="ov-number">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        size={7}
        value={text ?? String(value)}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => {
          const typed: string = event.currentTarget.value;
          setText(typed);
          stop();
          const parsed: number | null = parseWholeNumber(typed, limits);
          waiting.current = parsed !== null && parsed !== value ? parsed : null;
          if (waiting.current !== null) timer.current = setTimeout(commit, SAVE_IDLE_MS);
        }}
        onFocus={() => setLeft(false)}
        onBlur={() => {
          commit();
          if (text !== null && parseWholeNumber(text, limits) !== null) setText(null);
          else setLeft(true);
        }}
        {...data}
      />
      {invalid && (
        <span className="ov-number-invalid" id={errorId} role="alert" data-number-invalid>
          {t("overlay.comp.wholeNumber", { min: numbers.format(limits.min), max: numbers.format(limits.max) })}
        </span>
      )}
    </span>
  );
}

/**
 * The test list and **Send test** of the alerts layer. The server checks the saved layers, so the button is
 * unavailable while the saved alerts layer is not on stream, with the reason below it. A refusal of the server shows
 * as text under the button. The button keeps the focus during its request and ignores presses meanwhile.
 */
export function AlertTest({ onStream }: Readonly<{ onStream: boolean }>): ReactNode {
  const api: ControlApi = useContext(ControlApiContext);
  const labelId: string = useId();
  const reasonId: string = useId();
  const [test, setTest] = useState<TestAlert>(DEFAULT_TEST_ALERT);
  const [sending, setSending] = useState<boolean>(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [news, setNews] = useState<string>("");
  // A refusal tells about the layer as it was. When the layer goes on or off stream, the reason in view changes.
  const [shownFor, setShownFor] = useState<boolean>(onStream);
  if (shownFor !== onStream) {
    setShownFor(onStream);
    setFailure(null);
  }
  const unavailable: boolean = sending || !onStream;
  const options: SelectOption[] = shownTests().map(
    (value: TestAlert): SelectOption => ({ value, label: testName(value) }),
  );

  async function send(): Promise<void> {
    if (unavailable) return;
    const control: AlertControl = { op: "test", kind: test };
    setSending(true);
    setFailure(null);
    setNews("");
    try {
      await api.alerts(control);
      setNews(t("overlay.alerts.testSent"));
    } catch (error_: unknown) {
      setFailure(t("overlay.alerts.testFailed", { error: alertsFailure(error_) }));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="ov-alert-test" data-alert-test>
      <div className="ov-alert-test-row">
        <span className="field-label" id={labelId}>
          {t("overlay.alerts.testLabel")}
        </span>
        <Select
          labelledBy={labelId}
          options={options}
          value={test}
          onValueChange={(value: string) => {
            if (isTestAlert(value)) setTest(value);
          }}
        />
        <button
          type="button"
          className="small-button"
          aria-disabled={unavailable}
          aria-describedby={onStream ? undefined : reasonId}
          onClick={() => void send()}
          data-alert-send
        >
          <Icon name="play" size={16} />
          {t("overlay.alerts.sendTest")}
        </button>
      </div>
      {!onStream && (
        <p className="muted ov-comp-note" id={reasonId} data-alert-needs-layer>
          {t("overlay.alerts.testNeedsLayer")}
        </p>
      )}
      {failure && (
        <p className="ov-chars-invalid" role="alert" data-alert-failed>
          {failure}
        </p>
      )}
      <p className="sr-only" aria-live="polite" data-alert-news>
        {news}
      </p>
    </div>
  );
}

/** A switch of one rule in the table. Its name tells the column and the rule; a visible text adds to it. */
function RuleSwitch({
  checked,
  label,
  text,
  onChange,
  ...data
}: Readonly<{
  checked: boolean;
  label: string;
  text?: string;
  onChange: (checked: boolean) => void;
  [key: `data-${string}`]: string;
}>): ReactNode {
  return (
    <label className="choice ov-rule-switch">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.checked)}
        {...data}
      />
      {text && <span aria-hidden="true">{text}</span>}
    </label>
  );
}

/**
 * The name of a column in each cell. It shows only when a narrow table stacks its rows, where the header row is
 * hidden. A screen reader skips it: the control of the cell has the full name.
 */
function StackLabel({ id }: Readonly<{ id: MessageId }>): ReactNode {
  return (
    <span className="ov-rules-stack" aria-hidden="true">
      {t(id)}
    </span>
  );
}

/** One row of the rules table. */
function RuleRow({
  rule,
  value,
  onRule,
}: Readonly<{
  rule: AlertRuleId;
  value: AlertRule;
  onRule: (rule: AlertRuleId, patch: Partial<AlertRule>, when: EditTiming) => void;
}>): ReactNode {
  const name: string = t(RULE_NAMES[rule]);
  const action: string = t(ACTION_NAMES[RULE_ACTIONS[rule]]);
  return (
    <tr data-rule={rule}>
      <th scope="row" className="ov-rule-event">
        <Icon name={ALERT_ICONS[RULE_KINDS[rule]]} size={16} className="ov-rule-icon" />
        <span>
          <span className="ov-rule-name">{name}</span> <span className="muted">{t(RULE_NOTES[rule])}</span>
        </span>
      </th>
      <td>
        <StackLabel id="overlay.alerts.column.startsAt" />
        {hasThreshold(rule) ? (
          <WholeNumberInput
            value={value.min}
            limits={ALERT_MIN}
            label={t("overlay.alerts.minLabel", { rule: name })}
            onValue={(min: number, when: EditTiming) => onRule(rule, { min }, when)}
            data-rule-min
          />
        ) : (
          <span className="muted">{t("overlay.alerts.eachOne")}</span>
        )}
      </td>
      <td>
        <StackLabel id="overlay.alerts.column.banner" />
        <RuleSwitch
          checked={value.banner}
          label={t("overlay.alerts.bannerLabel", { rule: name })}
          onChange={(banner: boolean) => onRule(rule, { banner }, "now")}
          data-rule-switch="banner"
        />
      </td>
      <td>
        <StackLabel id="overlay.alerts.column.chat" />
        <RuleSwitch
          checked={value.chat}
          label={t("overlay.alerts.chatLabel", { rule: name })}
          onChange={(chat: boolean) => onRule(rule, { chat }, "now")}
          data-rule-switch="chat"
        />
      </td>
      <td>
        <StackLabel id="overlay.alerts.column.character" />
        <RuleSwitch
          checked={value.character}
          label={t("overlay.alerts.characterLabel", { rule: name, action })}
          text={action}
          onChange={(character: boolean) => onRule(rule, { character }, "now")}
          data-rule-switch="character"
        />
      </td>
    </tr>
  );
}

const HOW_ALERTS_BEHAVE: readonly MessageId[] = [
  "overlay.alerts.how.banner",
  "overlay.alerts.how.columns",
  "overlay.alerts.how.anonymous",
  "overlay.alerts.how.count",
  "overlay.alerts.how.controls",
  "overlay.alerts.how.motion",
];

/**
 * The rules of the alerts layer: a table with one row for each event. **Starts at** is a number for the rules with
 * an amount (THRESHOLD_RULES), and each of the three switches is one field of the rule. Each change saves as one
 * field of a layer change. In a narrow box each row stacks: the event, then its cells in two columns, each with the
 * name of its column. The table keeps its semantics, and each control has its own full name. Below it, the closed
 * **How alerts behave**.
 */
export function AlertRulesTable({
  rules,
  onRule,
}: Readonly<{
  rules: AlertRules;
  onRule: (rule: AlertRuleId, patch: Partial<AlertRule>, when: EditTiming) => void;
}>): ReactNode {
  return (
    <>
      <div className="ov-rules" data-alert-rules>
        <table className="ov-rules-table">
          <caption className="sr-only">{t("overlay.alerts.rules")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("overlay.alerts.column.event")}</th>
              <th scope="col">{t("overlay.alerts.column.startsAt")}</th>
              <th scope="col">{t("overlay.alerts.column.banner")}</th>
              <th scope="col">{t("overlay.alerts.column.chat")}</th>
              <th scope="col">{t("overlay.alerts.column.character")}</th>
            </tr>
          </thead>
          <tbody>
            {shownRules().map((rule: AlertRuleId) => (
              <RuleRow key={rule} rule={rule} value={rules[rule]} onRule={onRule} />
            ))}
          </tbody>
        </table>
      </div>
      <details className="ch-details ov-props-more" data-alert-help>
        <summary>{t("overlay.alerts.how.title")}</summary>
        <ul>
          {HOW_ALERTS_BEHAVE.map((id: MessageId) => (
            <li key={id}>{t(id)}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
