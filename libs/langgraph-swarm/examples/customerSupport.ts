import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { SystemMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createSwarm, createHandoffTool } from "@langchain/langgraph-swarm";

const model = new ChatOpenAI({ modelName: "gpt-4o" });

// Mock data for tools
const RESERVATIONS: Record<string, { flight_info: any; hotel_info: any }> = {};

// Helper function to get default value for reservations
const getReservation = (userId: string) => {
  if (!RESERVATIONS[userId]) {
    RESERVATIONS[userId] = { flight_info: {}, hotel_info: {} };
  }
  return RESERVATIONS[userId];
};

// Get tomorrow's date in ISO format
const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);
const TOMORROW_ISO = TOMORROW.toISOString().split("T")[0];

const FLIGHTS = [
  {
    departure_airport: "BOS",
    arrival_airport: "JFK",
    airline: "Jet Blue",
    date: TOMORROW_ISO,
    id: "1",
  },
];

const HOTELS = [
  {
    location: "New York",
    name: "McKittrick Hotel",
    neighborhood: "Chelsea",
    id: "1",
  },
];

// Flight tools
const searchFlights = tool(
  async (args) => {
    // Return all flights for simplicity
    return JSON.stringify(FLIGHTS);
  },
  {
    name: "search_flights",
    description:
      "Search flights. If unsure about airport codes, use the biggest airport in the area.",
    schema: z.object({
      departure_airport: z
        .string()
        .describe("3-letter airport code for the departure airport"),
      arrival_airport: z
        .string()
        .describe("3-letter airport code for the arrival airport"),
      date: z.string().describe("YYYY-MM-DD date"),
    }),
  }
);

const bookFlight = tool(
  async (args, runnable) => {
    const config = runnable as RunnableConfig;
    const userId = config.configurable?.user_id as string;
    const flight = FLIGHTS.find((flight) => flight.id === args.flight_id);

    if (flight) {
      getReservation(userId).flight_info = flight;
      return "Successfully booked flight";
    }
    return "Flight not found";
  },
  {
    name: "book_flight",
    description: "Book a flight",
    schema: z.object({
      flight_id: z.string(),
    }),
  }
);

// Hotel tools
const searchHotels = tool(
  async (args) => {
    // Return all hotels for simplicity
    return JSON.stringify(HOTELS);
  },
  {
    name: "search_hotels",
    description: "Search hotels",
    schema: z.object({
      location: z.string().describe("official, legal city name (proper noun)"),
    }),
  }
);

const bookHotel = tool(
  async (args, runnable) => {
    const config = runnable as RunnableConfig;
    const userId = config.configurable?.user_id as string;
    const hotel = HOTELS.find((hotel) => hotel.id === args.hotel_id);

    if (hotel) {
      getReservation(userId).hotel_info = hotel;
      return "Successfully booked hotel";
    }
    return "Hotel not found";
  },
  {
    name: "book_hotel",
    description: "Book a hotel",
    schema: z.object({
      hotel_id: z.string(),
    }),
  }
);

// Define handoff tools
const transferToHotelAssistant = createHandoffTool({
  agentName: "hotel_assistant",
  description:
    "Transfer user to the hotel-booking assistant that can search for and book hotels.",
});

const transferToFlightAssistant = createHandoffTool({
  agentName: "flight_assistant",
  description:
    "Transfer user to the flight-booking assistant that can search for and book flights.",
});

// Define agent prompt function
const makePrompt = (baseSystemPrompt: string) => {
  return (state: any, config: RunnableConfig) => {
    const userId = config.configurable?.user_id as string;
    const currentReservation = getReservation(userId);
    const systemPrompt = `${baseSystemPrompt}\n\nUser's active reservation: ${JSON.stringify(
      currentReservation
    )}\nToday is: ${new Date().toString()}`;

    return [new SystemMessage({ content: systemPrompt }), ...state.messages];
  };
};

// Define agents
const flightAssistant = createReactAgent({
  llm: model,
  tools: [searchFlights, bookFlight, transferToHotelAssistant],
  prompt: makePrompt("You are a flight booking assistant"),
  name: "flight_assistant",
});

const hotelAssistant = createReactAgent({
  llm: model,
  tools: [searchHotels, bookHotel, transferToFlightAssistant],
  prompt: makePrompt("You are a hotel booking assistant"),
  name: "hotel_assistant",
});

// Compile and run!
const checkpointer = new MemorySaver();
const builder = createSwarm({
  agents: [flightAssistant, hotelAssistant],
  defaultActiveAgent: "flight_assistant",
});

// Important: compile the swarm with a checkpointer to remember
// previous interactions and last active agent
export const app = builder.compile({
  checkpointer,
});

// Example usage
// const config = { configurable: { user_id: "user123", thread_id: "1" } };
// const result = await app.invoke({ messages: [{ role: "user", content: "I need to book a flight from Boston to New York tomorrow" }] }, config);
// console.log(result);
