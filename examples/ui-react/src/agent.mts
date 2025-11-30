import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod/v4";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

export const getWeather = tool(
  async ({ location }) => {
    // Use Open-Meteo geocoding API to get coordinates
    const geoResponse = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`
    );
    const geoData = await geoResponse.json();

    if (!geoData.results?.length) {
      return { status: "error", content: `Could not find location: ${location}` };
    }

    const { latitude, longitude, name, country } = geoData.results[0];

    // Fetch weather from Open-Meteo API (no API key required)
    const weatherResponse = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m`
    );
    const weatherData = await weatherResponse.json();

    const { temperature_2m, weather_code, wind_speed_10m, relative_humidity_2m } =
      weatherData.current;

    // Map weather codes to descriptions
    const weatherDescriptions: Record<number, string> = {
      0: "Clear sky",
      1: "Mainly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Depositing rime fog",
      51: "Light drizzle",
      53: "Moderate drizzle",
      55: "Dense drizzle",
      61: "Slight rain",
      63: "Moderate rain",
      65: "Heavy rain",
      71: "Slight snow",
      73: "Moderate snow",
      75: "Heavy snow",
      80: "Slight rain showers",
      81: "Moderate rain showers",
      82: "Violent rain showers",
      95: "Thunderstorm",
    };

    const description = weatherDescriptions[weather_code] || "Unknown conditions";

    return { status: "success", content: `Weather in ${name}, ${country}: ${description}, ${temperature_2m}°C, Wind: ${wind_speed_10m} km/h, Humidity: ${relative_humidity_2m}%` };
  },
  {
    name: "get_weather",
    description: "Get the current weather for a location",
    schema: z.object({
      location: z.string().describe("The city or location to get weather for"),
    }),
  }
);

export const search = tool(
  async ({ query }) => {
    return `Search results for ${query}`;
  },
  {
    name: "search",
    description: "Search the web for information",
    schema: z.object({
      query: z.string().describe("The query to search for"),
    }),
  }
);

export const agent = createAgent({
  model,
  tools: [getWeather, search],
  systemPrompt: "You are a helpful assistant that can answer questions and help with tasks.",
});