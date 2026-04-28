import { MemorySaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import { model } from "./shared";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const searchFlights = tool(
  async function* ({
    destination,
    departureDate,
  }: {
    destination: string;
    departureDate: string;
  }) {
    const airlines = ["United", "Delta", "American", "JetBlue"];
    const completed: string[] = [];
    for (let index = 0; index < airlines.length; index += 1) {
      await sleep(450);
      const found = `$${Math.floor(Math.random() * 400) + 200}`;
      completed.push(`${airlines[index]} from ${found}`);
      yield {
        message: `Searching ${airlines[index]}...`,
        progress: (index + 1) / airlines.length,
        completed,
      };
    }
    return JSON.stringify({
      destination,
      departureDate,
      flights: completed,
    });
  },
  {
    name: "search_flights",
    description: "Search for flights and stream progress by airline.",
    schema: z.object({
      destination: z.string().describe("Destination city."),
      departureDate: z.string().describe("Departure date, YYYY-MM-DD."),
    }),
  }
);

const checkHotels = tool(
  async function* ({ city, nights }: { city: string; nights: number }) {
    const hotels = ["Grand Hyatt", "Marriott Suites", "Hilton Garden Inn"];
    const completed: string[] = [];
    for (let index = 0; index < hotels.length; index += 1) {
      await sleep(500);
      completed.push(
        `${hotels[index]}: $${Math.floor(Math.random() * 240) + 120}/night`
      );
      yield {
        message: `Checking ${hotels[index]}...`,
        progress: (index + 1) / hotels.length,
        completed,
      };
    }
    return JSON.stringify({ city, nights, hotels: completed });
  },
  {
    name: "check_hotels",
    description: "Check hotel availability and stream progress.",
    schema: z.object({
      city: z.string().describe("City to search."),
      nights: z.number().describe("Number of nights."),
    }),
  }
);

const planItinerary = tool(
  async function* ({
    destination,
    days,
    interests,
  }: {
    destination: string;
    days: number;
    interests: string[];
  }) {
    const completed: string[] = [];
    for (let day = 1; day <= days; day += 1) {
      await sleep(450);
      const theme = interests[(day - 1) % Math.max(interests.length, 1)] ?? "local culture";
      completed.push(`Day ${day}: ${theme} around ${destination}`);
      yield {
        message: `Planning day ${day}...`,
        progress: day / days,
        completed,
      };
    }
    return JSON.stringify({ destination, days, itinerary: completed });
  },
  {
    name: "plan_itinerary",
    description: "Create a day-by-day itinerary and stream planning progress.",
    schema: z.object({
      destination: z.string().describe("Travel destination."),
      days: z.number().describe("Trip length in days."),
      interests: z.array(z.string()).describe("Traveler interests."),
    }),
  }
);

export const agent = createAgent({
  model,
  tools: [searchFlights, checkHotels, planItinerary],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a travel planning assistant. Use the available tools
for travel requests so the UI can display live progress. Summarize the tool
results into a practical plan once they complete.`,
});
