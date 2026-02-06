import { config } from "../config";

type WeatherApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    weather?: {
      location?: {
        name?: string;
        state?: string;
        coordinates?: {
          lat?: string | number;
          lon?: string | number;
        };
      };
      current?: {
        condition?: string;
        temperature?: string | number;
        feels_like?: string | number;
        humidity?: string | number;
        wind?: {
          direction?: string;
          speed?: string;
        };
      };
      air_quality?: {
        aqi?: string | number;
      };
      metadata?: {
        last_updated?: string;
      };
    };
    forecast?: Array<{
      date?: string;
      high_temp?: string | number;
      low_temp?: string | number;
    }>;
    error?: unknown;
  };
};

function asText(value: unknown, fallback = "未知"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getWeatherEmoji(condition: string): string {
  const weatherEmojis: Record<string, string> = {
    '晴朗': '☀️', '晴': '☀️', '多云': '⛅', '阴': '☁️', '小雨': '🌧️', '中雨': '🌧️', '大雨': '⛈️', '暴雨': '🌊','雷阵雨': '⛈️', '雨': '🌧️', '阵雨': '🌦️', '小雪': '🌨️', '中雪': '❄️', '大雪': '❄️', '暴雪': '☃️', '雪': '❄️', '雨夹雪': '🌨️', '雾': '🌫️', '霾': '😷', '沙尘': '🏜️',
  };

  for (const [key, emoji] of Object.entries(weatherEmojis)) {
    if (condition.includes(key)) {
      return emoji;
    }
  }
  return "️🌤️";
}

function getTempEmoji(temp: number): string {
  if (temp >= 35) return "🥵";
  if (temp >= 25) return "😎";
  if (temp >= 15) return "😊";
  if (temp >= 5) return "🧥";
  if (temp >= -5) return "🥶";
  return "🧊";
}

function getWindEmoji(speed: string): string {
  const match = speed.match(/(\d+)/);
  if (match) {
    const level = Number(match[1]);
    if (level <= 2) return "🍃";
    if (level <= 4) return "🌬️";
    if (level <= 6) return "💨";
    return "🌪️";
  }
  return "🍃";
}

function getAqiEmoji(aqi: number): string {
  if (aqi <= 50) return "🟢 优";
  if (aqi <= 100) return "🟡 良";
  if (aqi <= 150) return "🟠 轻度污染";
  if (aqi <= 200) return "🔴 中度污染";
  return "🟣 重度污染";
}

function formatLocalTime(iso8601: string): string {
  const date = new Date(iso8601);
  if (Number.isNaN(date.getTime())) {
    return iso8601.slice(0, 16).replace("T", " ");
  }

  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }
  const year = values.year ?? "0000";
  const month = values.month ?? "00";
  const day = values.day ?? "00";
  const hour = values.hour ?? "00";
  const minute = values.minute ?? "00";
  const second = values.second ?? "00";
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function formatWeatherInfo(weatherData: WeatherApiResponse): string {
  try {
    const data = weatherData.data ?? {};
    const weather = data.weather ?? {};
    const location = weather.location ?? {};
    const current = weather.current ?? {};
    const forecast = Array.isArray(data.forecast) ? data.forecast : [];
    const airQuality = weather.air_quality ?? {};
    const wind = current.wind ?? {};

    const state = asText(location.state, "");
    const cityName = asText(location.name, "未知");
    const condition = asText(current.condition, "未知");
    const temp = asNumber(current.temperature) ?? 0;
    const feelsLike = asNumber(current.feels_like) ?? 0;
    const humidity = asNumber(current.humidity) ?? 0;
    const windDir = asText(wind.direction, "未知");
    const windSpeed = asText(wind.speed, "未知");
    const aqi = asNumber(airQuality.aqi) ?? 0;

    let output = `
🌍 ${state} · ${cityName.toUpperCase()}

${getWeatherEmoji(condition)} 当前天气: ${condition}
${getTempEmoji(temp)} 温度: ${temp}°C (体感 ${feelsLike}°C)
${getWindEmoji(windSpeed)} 风况: ${windDir} ${windSpeed}
💧 湿度: ${humidity}%
🌬️ 空气质量: AQI ${aqi} ${getAqiEmoji(aqi)}

📅 今日与未来四天天气预报:
`;

    for (const day of forecast) {
      const date = asText(day?.date, "");
      const high = asNumber(day?.high_temp) ?? 0;
      const low = asNumber(day?.low_temp) ?? 0;
      output += `  ${date}: ${getTempEmoji(high)} ${low}°C ~ ${high}°C\n`;
    }

    const lastUpdated = asText(weather.metadata?.last_updated, "未知");
    let timeStr = "未知";
    if (lastUpdated !== "未知") {
      try {
        timeStr = formatLocalTime(lastUpdated);
      } catch {
        timeStr = lastUpdated.slice(0, 16).replace("T", " ");
      }
    }
    output += `\n🕐 数据更新于: ${timeStr}`;

    return output.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ 天气信息解析失败: ${message}`;
  }
}

export async function fetchWeatherSummary(location: string): Promise<string> {
  const city = location.trim();
  if (!city) {
    throw new Error("[weather] location is required");
  }

  const apiKey = config.weather.apiKey;
  if (!apiKey) {
    throw new Error("天气功能未配置：请设置 WEATHER_API_KEY");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, config.weather.timeoutMs));
  try {
    const url = `https://api2.wer.plus/api/weather?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ city }).toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`[weather] request failed status=${response.status}`);
    }

    const payload = (await response.json()) as WeatherApiResponse;
    return formatWeatherInfo(payload);
  } finally {
    clearTimeout(timer);
  }
}
