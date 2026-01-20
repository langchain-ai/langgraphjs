import { tool } from "langchain";
import { z } from "zod/v3";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

// ============================================================================
// Weather Scout Tools
// ============================================================================

const getWeatherForecast = tool(
  async ({ location, days }) => {
    // Use Open-Meteo geocoding API to get coordinates
    const geoResponse = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        location
      )}&count=1`
    );
    const geoData = await geoResponse.json();

    if (!geoData.results?.length) {
      return JSON.stringify({ error: `Could not find location: ${location}` });
    }

    const { latitude, longitude, name, country } = geoData.results[0];

    // Fetch extended forecast
    const weatherResponse = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=${days}`
    );
    const weatherData = await weatherResponse.json();

    const weatherCodes: Record<number, string> = {
      0: "☀️ Clear",
      1: "🌤️ Mainly clear",
      2: "⛅ Partly cloudy",
      3: "☁️ Overcast",
      45: "🌫️ Foggy",
      51: "🌧️ Light drizzle",
      61: "🌧️ Rain",
      71: "❄️ Snow",
      80: "🌦️ Showers",
      95: "⛈️ Thunderstorm",
    };

    const forecast = weatherData.daily.time.map((date: string, i: number) => ({
      date,
      high: `${weatherData.daily.temperature_2m_max[i]}°C`,
      low: `${weatherData.daily.temperature_2m_min[i]}°C`,
      precipitation: `${weatherData.daily.precipitation_probability_max[i]}%`,
      condition: weatherCodes[weatherData.daily.weather_code[i]] || "Unknown",
    }));

    return JSON.stringify({
      location: `${name}, ${country}`,
      forecast,
      summary: `Weather forecast for ${name}: ${forecast[0].condition}, highs around ${forecast[0].high}`,
    });
  },
  {
    name: "get_weather_forecast",
    description: "Get weather forecast for a location for the next N days",
    schema: z.object({
      location: z.string().describe("City or location name"),
      days: z
        .number()
        .min(1)
        .max(14)
        .default(7)
        .describe("Number of forecast days"),
    }),
  }
);

const getBestTravelSeason = tool(
  async ({ destination }) => {
    // Simulate seasonal data (in real app, would query a travel API)
    const seasons: Record<
      string,
      { best: string; avoid: string; tip: string }
    > = {
      default: {
        best: "Spring (Apr-May) and Fall (Sep-Oct)",
        avoid: "Peak summer crowds",
        tip: "Book 2-3 months in advance for best rates",
      },
    };

    // Simulate API delay
    await new Promise((r) => setTimeout(r, 500));

    return JSON.stringify({
      destination,
      ...seasons.default,
      note: "Based on typical travel patterns and weather data",
    });
  },
  {
    name: "get_best_travel_season",
    description: "Get the best time of year to visit a destination",
    schema: z.object({
      destination: z.string().describe("The destination to check"),
    }),
  }
);

// ============================================================================
// Experience Curator Tools
// ============================================================================

const searchAttractions = tool(
  async ({ location, category }) => {
    // Use Open-Meteo geocoding to get location name
    const geoResponse = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        location
      )}&count=1`
    );
    const geoData = await geoResponse.json();

    const name = geoData.results?.[0]?.name || location;

    // Provide realistic attraction data
    const attractions = [
      { name: `${name} Historical Center`, type: "cultural", rating: "4.5" },
      { name: `${name} Art Museum`, type: "museums", rating: "4.3" },
      { name: `Local Market of ${name}`, type: "shopping", rating: "4.7" },
      { name: `${name} Gardens`, type: "nature", rating: "4.4" },
      { name: `${name} Food Tour`, type: "gastronomy", rating: "4.8" },
    ].filter((a) => category === "all" || a.type === category);

    return JSON.stringify({
      location: name,
      category,
      attractions,
      tip: `Pro tip: Book popular attractions in ${name} at least 1 week in advance!`,
    });
  },
  {
    name: "search_attractions",
    description: "Search for attractions, activities, and points of interest",
    schema: z.object({
      location: z.string().describe("City or destination"),
      category: z
        .enum([
          "all",
          "museums",
          "nature",
          "cultural",
          "restaurants",
          "nightlife",
        ])
        .default("all")
        .describe("Category of attractions"),
    }),
  }
);

const getLocalEvents = tool(
  async ({ location, dateRange }) => {
    // Simulate event search
    await new Promise((r) => setTimeout(r, 400));

    const events = [
      { name: "Local Food Festival", type: "festival", price: "Free entry" },
      { name: "Jazz Night at the Plaza", type: "music", price: "$25-45" },
      { name: "Sunset Walking Tour", type: "tour", price: "$15" },
      { name: "Artisan Market", type: "market", price: "Free" },
    ];

    return JSON.stringify({
      location,
      dateRange,
      events,
      note: "Events subject to availability. Book early for popular events!",
    });
  },
  {
    name: "get_local_events",
    description: "Find local events and activities happening during your visit",
    schema: z.object({
      location: z.string().describe("City or destination"),
      dateRange: z
        .string()
        .describe("Date range for events (e.g., 'Dec 15-22')"),
    }),
  }
);

// ============================================================================
// Budget Optimizer Tools
// ============================================================================

const estimateFlightCost = tool(
  async ({ origin, destination, travelers }) => {
    // Simulate flight price estimation
    await new Promise((r) => setTimeout(r, 600));

    const basePrice = Math.floor(Math.random() * 300) + 200;
    const totalPrice = basePrice * travelers;

    return JSON.stringify({
      route: `${origin} → ${destination}`,
      pricePerPerson: `$${basePrice}`,
      totalForGroup: `$${totalPrice}`,
      travelers,
      tips: [
        "Book 6-8 weeks in advance for best rates",
        "Consider nearby airports for savings",
        "Tuesday/Wednesday flights often cheaper",
      ],
      bestDeal: {
        airline: "Sample Airways",
        price: `$${basePrice - 50}`,
        note: "Flexible dates could save $50+",
      },
    });
  },
  {
    name: "estimate_flight_cost",
    description: "Estimate flight costs between two cities",
    schema: z.object({
      origin: z.string().describe("Departure city"),
      destination: z.string().describe("Arrival city"),
      travelers: z.number().min(1).default(1).describe("Number of travelers"),
    }),
  }
);

const estimateAccommodation = tool(
  async ({ location, nights, style }) => {
    await new Promise((r) => setTimeout(r, 500));

    const priceRanges: Record<string, { min: number; max: number }> = {
      budget: { min: 40, max: 80 },
      midrange: { min: 100, max: 180 },
      luxury: { min: 250, max: 500 },
    };

    const range = priceRanges[style] || priceRanges.midrange;
    const avgPrice = Math.floor((range.min + range.max) / 2);
    const totalCost = avgPrice * nights;

    return JSON.stringify({
      location,
      nights,
      style,
      averagePerNight: `$${avgPrice}`,
      totalEstimate: `$${totalCost}`,
      recommendations: [
        {
          name: `${style === "luxury" ? "Grand" : "Cozy"} ${location} Hotel`,
          price: `$${avgPrice}`,
          rating: "4.5★",
        },
        {
          name: `${location} ${style === "budget" ? "Hostel" : "Suites"}`,
          price: `$${avgPrice - 20}`,
          rating: "4.3★",
        },
      ],
      tip:
        style === "budget"
          ? "Consider hostels or Airbnb for even better rates!"
          : "Book directly with hotels for potential upgrades",
    });
  },
  {
    name: "estimate_accommodation",
    description: "Estimate accommodation costs for a destination",
    schema: z.object({
      location: z.string().describe("City or destination"),
      nights: z.number().min(1).describe("Number of nights"),
      style: z
        .enum(["budget", "midrange", "luxury"])
        .default("midrange")
        .describe("Accommodation style"),
    }),
  }
);

const calculateTotalBudget = tool(
  async ({ flights, accommodation, dailyExpenses, days, travelers }) => {
    await new Promise((r) => setTimeout(r, 300));

    const flightTotal = flights * travelers;
    const accomTotal = accommodation;
    const expenseTotal = dailyExpenses * days * travelers;
    const total = flightTotal + accomTotal + expenseTotal;

    return JSON.stringify({
      breakdown: {
        flights: `$${flightTotal}`,
        accommodation: `$${accomTotal}`,
        dailyExpenses: `$${expenseTotal}`,
      },
      totalEstimate: `$${total}`,
      perPerson: `$${Math.round(total / travelers)}`,
      savingsTips: [
        "Use public transport to save on taxis",
        "Eat at local markets for authentic, cheap meals",
        "Book combo tickets for attractions",
      ],
    });
  },
  {
    name: "calculate_total_budget",
    description: "Calculate the total trip budget",
    schema: z.object({
      flights: z.number().describe("Flight cost per person"),
      accommodation: z.number().describe("Total accommodation cost"),
      dailyExpenses: z.number().describe("Estimated daily expenses per person"),
      days: z.number().describe("Number of days"),
      travelers: z.number().describe("Number of travelers"),
    }),
  }
);

// ============================================================================
// Create Deep Agent with Subagents
// ============================================================================

const checkpointer = new MemorySaver();
export const agent = createDeepAgent({
  model: "gpt-5.2",
  checkpointer,
  subagents: [
    {
      name: "weather-scout",
      description:
        "Weather and climate specialist. Checks forecasts, finds the best travel seasons, and ensures you pack right. Use this agent to understand weather conditions at your destination.",
      systemPrompt: `You are a weather and climate specialist for travel planning. Your job is to:
1. Check weather forecasts for the destination
2. Recommend the best time to visit
3. Provide packing suggestions based on expected conditions
4. Warn about any weather-related concerns

Always provide specific, actionable weather information.`,
      tools: [getWeatherForecast, getBestTravelSeason],
    },
    {
      name: "experience-curator",
      description:
        "Local experiences expert. Discovers hidden gems, popular attractions, local events, and unique activities. Use this agent to find what to do at your destination.",
      systemPrompt: `You are a local experiences curator and travel insider. Your job is to:
1. Find the best attractions and activities
2. Discover local events happening during the visit
3. Recommend hidden gems and unique experiences
4. Create a diverse mix of activities (culture, food, nature, etc.)

Focus on creating memorable, authentic experiences.`,
      tools: [searchAttractions, getLocalEvents],
    },
    {
      name: "budget-optimizer",
      description:
        "Travel budget specialist. Estimates costs for flights, hotels, and daily expenses. Finds deals and creates detailed budget breakdowns. Use this agent for all cost-related planning.",
      systemPrompt: `You are a travel budget optimizer. Your job is to:
1. Estimate flight and accommodation costs
2. Calculate total trip budgets
3. Find cost-saving opportunities
4. Provide realistic price expectations

Always provide specific numbers and money-saving tips.`,
      tools: [estimateFlightCost, estimateAccommodation, calculateTotalBudget],
    },
  ],
  systemPrompt: `You are a Dream Vacation Planner - an AI travel coordinator that orchestrates specialized agents to create perfect trip plans.

When a user asks about planning a trip, you should launch ALL THREE subagents in PARALLEL to work simultaneously:

1. **weather-scout** - Check weather and best travel times
2. **experience-curator** - Find attractions, activities, and local events
3. **budget-optimizer** - Calculate costs and find deals

IMPORTANT: Launch all three agents at the same time using parallel tool calls! This gives the user real-time visibility into each specialist working on their trip.

After all agents complete, synthesize their findings into a cohesive vacation plan that includes:
- Weather summary and packing suggestions
- Top recommended experiences and activities
- Detailed budget breakdown
- Pro tips for the destination

Make the final plan exciting and actionable!`,
});
