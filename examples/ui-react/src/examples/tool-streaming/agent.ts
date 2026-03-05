import z from "zod";
import { tool, createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

const model = new ChatOpenAI({
  model: "gpt-4o-mini",
});

const searchFlightsSchema = z.object({
  destination: z.string().describe("The destination city"),
  departureDate: z.string().describe("The departure date (YYYY-MM-DD)"),
});

const searchFlightsTool = tool(
  async function* ({
    destination,
    departureDate,
  }: z.infer<typeof searchFlightsSchema>) {
    const airlines = [
      "United Airlines",
      "Delta Air Lines",
      "American Airlines",
      "JetBlue",
    ];
    const completed: string[] = [];

    for (let i = 0; i < airlines.length; i++) {
      await new Promise((r) => setTimeout(r, 600));
      const found = `$${Math.floor(Math.random() * 400) + 200}`;
      completed.push(`${airlines[i]} — from ${found}`);
      yield {
        message: `Searching ${airlines[i]}...`,
        progress: (i + 1) / airlines.length,
        completed,
      };
    }

    // Brief pause so the UI renders the final step before the card disappears
    await new Promise((r) => setTimeout(r, 300));

    const flights = airlines.map((airline) => ({
      airline,
      departure: departureDate,
      destination,
      price: Math.floor(Math.random() * 400) + 200,
      duration: `${Math.floor(Math.random() * 8) + 3}h ${
        Math.floor(Math.random() * 50) + 10
      }m`,
      stops: Math.random() > 0.5 ? 1 : 0,
    }));

    return JSON.stringify({ flights }, null, 2);
  },
  {
    name: "search_flights",
    description:
      "Search for available flights to a destination on a given date",
    schema: searchFlightsSchema,
  }
);

const checkHotelAvailabilitySchema = z.object({
  city: z.string().describe("The city to search for hotels"),
  checkIn: z.string().describe("Check-in date (YYYY-MM-DD)"),
  nights: z.number().describe("Number of nights to stay"),
});

const checkHotelAvailabilityTool = tool(
  async function* ({
    city,
    checkIn,
    nights,
  }: z.infer<typeof checkHotelAvailabilitySchema>) {
    const hotels = [
      "Grand Hyatt",
      "Marriott Suites",
      "Hilton Garden Inn",
      "Four Seasons",
      "Ritz-Carlton",
    ];
    const completed: string[] = [];

    for (let i = 0; i < hotels.length; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const price = Math.floor(Math.random() * 300) + 100;
      const rating = (Math.random() * 2 + 3).toFixed(1);
      completed.push(`${hotels[i]} — $${price}/night, ${rating}★`);
      yield {
        message: `Checking ${hotels[i]}...`,
        progress: (i + 1) / hotels.length,
        completed,
      };
    }

    await new Promise((r) => setTimeout(r, 300));

    const available = hotels.map((name) => ({
      name,
      city,
      checkIn,
      nights,
      pricePerNight: Math.floor(Math.random() * 300) + 100,
      rating: (Math.random() * 2 + 3).toFixed(1),
      amenities: ["WiFi", "Pool", "Gym", "Restaurant"].slice(
        0,
        Math.floor(Math.random() * 3) + 2
      ),
    }));

    return JSON.stringify({ hotels: available }, null, 2);
  },
  {
    name: "check_hotel_availability",
    description: "Check hotel availability in a city for given dates",
    schema: checkHotelAvailabilitySchema,
  }
);

const planItinerarySchema = z.object({
  destination: z.string().describe("The travel destination"),
  days: z.number().describe("Number of days for the trip"),
  interests: z
    .array(z.string())
    .describe("Traveler interests (e.g. food, history, nature)"),
});

const planItineraryTool = tool(
  async function* ({
    destination,
    days,
    interests,
  }: z.infer<typeof planItinerarySchema>) {
    const activities = [
      "Visit local markets",
      "Guided walking tour",
      "Museum exploration",
      "Try local cuisine",
      "Temple or shrine visit",
      "Scenic viewpoint hike",
      "Cooking class",
      "Cultural performance",
      "Shopping district tour",
      "Sunset cruise",
    ];

    const completed: string[] = [];
    const itinerary = [];

    for (let i = 0; i < days; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const dayActivities = Array.from(
        { length: Math.floor(Math.random() * 2) + 2 },
        () => activities[Math.floor(Math.random() * activities.length)]
      );
      const theme = interests[i % interests.length] ?? "exploration";
      completed.push(`Day ${i + 1} (${theme}): ${dayActivities.join(", ")}`);
      yield {
        message: `Planning day ${i + 1} of ${days}...`,
        progress: (i + 1) / days,
        completed,
      };
      itinerary.push({
        day: i + 1,
        theme,
        activities: dayActivities,
        meals: {
          lunch: `Local ${destination} restaurant`,
          dinner: `${
            ["Traditional", "Modern", "Fusion"][Math.floor(Math.random() * 3)]
          } dining`,
        },
      });
    }

    await new Promise((r) => setTimeout(r, 300));

    return JSON.stringify({ destination, days, itinerary }, null, 2);
  },
  {
    name: "plan_itinerary",
    description:
      "Create a day-by-day travel itinerary for a destination based on interests",
    schema: planItinerarySchema,
  }
);

export const agent = createAgent({
  model,
  tools: [searchFlightsTool, checkHotelAvailabilityTool, planItineraryTool],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful travel planning assistant. When users ask about travel, use the available tools to search for flights, check hotel availability, and plan itineraries. Always use the tools rather than making up information. Provide a helpful summary after receiving tool results.`,
});
