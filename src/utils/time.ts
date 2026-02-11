export type TimeQueryIntent = {
  timezone: string;
  label: string;
};

const CITY_TIMEZONES: Record<string, { timezone: string; label: string }> = {
  北京: { timezone: "Asia/Shanghai", label: "北京" },
  上海: { timezone: "Asia/Shanghai", label: "上海" },
  广州: { timezone: "Asia/Shanghai", label: "广州" },
  深圳: { timezone: "Asia/Shanghai", label: "深圳" },
  香港: { timezone: "Asia/Hong_Kong", label: "香港" },
  台北: { timezone: "Asia/Taipei", label: "台北" },
  东京: { timezone: "Asia/Tokyo", label: "东京" },
  首尔: { timezone: "Asia/Seoul", label: "首尔" },
  新加坡: { timezone: "Asia/Singapore", label: "新加坡" },
  伦敦: { timezone: "Europe/London", label: "伦敦" },
  巴黎: { timezone: "Europe/Paris", label: "巴黎" },
  柏林: { timezone: "Europe/Berlin", label: "柏林" },
  纽约: { timezone: "America/New_York", label: "纽约" },
  洛杉矶: { timezone: "America/Los_Angeles", label: "洛杉矶" },
  温哥华: { timezone: "America/Vancouver", label: "温哥华" },
  悉尼: { timezone: "Australia/Sydney", label: "悉尼" },
};

function formatDateByTimezone(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  return formatter.format(now);
}

function parseUtcTimezone(raw: string): TimeQueryIntent | undefined {
  const matched = raw.match(/UTC\s*([+-])\s*(\d{1,2})/i);
  if (!matched) return undefined;
  const sign = matched[1] === "-" ? "-" : "+";
  const hour = Math.min(14, Math.max(0, Number(matched[2])));
  const padded = String(hour).padStart(2, "0");
  const timezone = `Etc/GMT${sign === "+" ? "-" : "+"}${padded}`;
  return {
    timezone,
    label: `UTC${sign}${hour}`,
  };
}

export function detectTimeIntent(text: string): TimeQueryIntent | undefined {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("/")) return undefined;
  if (!/(时间|几点|几点了|几号|日期|时区)/.test(normalized)) return undefined;

  for (const [city, value] of Object.entries(CITY_TIMEZONES)) {
    if (normalized.includes(city)) {
      return value;
    }
  }

  const utc = parseUtcTimezone(normalized);
  if (utc) return utc;

  return {
    timezone: "Asia/Shanghai",
    label: "北京时间",
  };
}

export function getTimeSummary(intent: TimeQueryIntent): string {
  try {
    return `${intent.label} 当前时间：${formatDateByTimezone(intent.timezone)}`;
  } catch {
    return `${intent.label} 当前时间获取失败`;
  }
}
