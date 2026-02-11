import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

import {
  getWeatherForecast,
  getBestTravelSeason,
  estimateFlightCost,
  estimateAccommodation,
  calculateTotalBudget,
  searchAttractions,
  getLocalEvents,
} from "./tools";

/**
 * Create a Deep Agent with subagents
 */
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
