import Meal from '../../models/yper/Meal.js';
import Workout from '../../models/yper/Workout.js';
import WorkoutLog from '../../models/yper/WorkoutLog.js';
import Profile from '../../models/yper/Profile.js';
import BodyMeasurement from '../../models/yper/BodyMeasurement.js';
import { mealTotals, sumTotals, dayRange } from '../../services/nutrition.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function dashboardRoutes(fastify) {
  fastify.get('/', async (request) => {
    const user = request.user.userId;
    const today = new Date();
    const { start, end } = dayRange(today);
    const weekAgo = new Date(start.getTime() - 6 * DAY_MS);

    const [profile, todayMeals, weekLogs, todaysWorkouts, lastMeasurement] = await Promise.all([
      Profile.getOrCreate(user),
      Meal.find({ user, date: { $gte: start, $lt: end } }).populate('items.food').lean(),
      WorkoutLog.find({ user, date: { $gte: weekAgo } })
        .populate('workout', 'name focus')
        .sort({ date: -1 }),
      Workout.find({ user, active: true, weekdays: today.getDay() })
        .populate('items.exercise')
        .lean(),
      BodyMeasurement.findOne({ user }).sort({ date: -1 }).lean(),
    ]);

    const consumed = sumTotals(todayMeals.map(mealTotals));

    return {
      targets: {
        calories: profile.dailyCalories,
        protein: profile.proteinTarget,
        carbs: profile.carbsTarget,
        fat: profile.fatTarget,
      },
      consumed,
      remaining: {
        calories: Math.round(profile.dailyCalories - consumed.calories),
        protein: Math.round(profile.proteinTarget - consumed.protein),
        carbs: Math.round(profile.carbsTarget - consumed.carbs),
        fat: Math.round(profile.fatTarget - consumed.fat),
      },
      mealsToday: todayMeals.length,
      workoutsThisWeek: weekLogs.length,
      workoutTargetPerWeek: profile.workoutDaysPerWeek,
      todaysWorkouts,
      recentLogs: weekLogs.slice(0, 5).map((log) => log.toJSON()),
      lastMeasurement,
    };
  });
}
