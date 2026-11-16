package dev.reeflight.k7

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

/**
 * The natural cycle's next 60 days, prepared by the app, and what the
 * background job last did with them.
 */
object DailyPlan {
    private const val PREFS = "daily_plan"
    private const val WORK = "reef-light-daily"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(ctx: Context, json: String) {
        val plan = JSONObject(json)
        prefs(ctx).edit().putString("plan", json).apply()
        plan.optString("applied", "").takeIf { it.isNotEmpty() && it != "null" }?.let { markApplied(ctx, it) }
        val req = PeriodicWorkRequestBuilder<DailyLightWorker>(1, TimeUnit.HOURS).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove("plan").apply()
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
    }

    fun plan(ctx: Context): JSONObject? = prefs(ctx).getString("plan", null)?.let { JSONObject(it) }

    fun applied(ctx: Context): String? = prefs(ctx).getString("applied", null)

    fun markApplied(ctx: Context, date: String) = prefs(ctx).edit().putString("applied", date).apply()

    fun setResult(ctx: Context, text: String) {
        val stamp = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))
        prefs(ctx).edit().putString("result", "${LocalDate.now()} $stamp, $text.").apply()
    }

    fun status(ctx: Context): JSONObject {
        val p = plan(ctx)
        return JSONObject()
            .put("hasPlan", p != null)
            .put("days", p?.optJSONObject("frames")?.length() ?: 0)
            .put("applied", applied(ctx))
            .put("lastResult", prefs(ctx).getString("result", null))
    }
}

/**
 * Runs about once an hour. Sends today's light once, if the phone can reach
 * the light over WiFi (on the light's own hotspot, or on the home WiFi when
 * the light is on it). Skips while the app is open: the app does it then.
 */
class DailyLightWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        if (MainActivity.inForeground) return Result.success()
        val plan = DailyPlan.plan(ctx) ?: return Result.success()
        val today = LocalDate.now().toString()
        if (DailyPlan.applied(ctx) == today) return Result.success()
        val hex = plan.optJSONObject("frames")?.optString(today, "") ?: ""
        if (hex.isEmpty()) {
            DailyPlan.setResult(ctx, "the prepared days have run out; open the app to prepare more")
            return Result.success()
        }
        if (WifiNet.network(ctx) == null) {
            DailyPlan.setResult(ctx, "not on WiFi, will try again")
            return Result.success()
        }
        val frame = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        val now = LocalTime.now()
        val hosts = listOfNotNull(plan.optString("host", "").ifEmpty { null }, WifiNet.dhcpServer(ctx)).distinct()
        var last = "could not reach the light"
        for (host in hosts) {
            val r = DailySender.send(host, 8266, frame, Triple(now.hour, now.minute, now.second), { WifiNet.socket(ctx) })
            if (r.sent) {
                DailyPlan.markApplied(ctx, today)
                DailyPlan.setResult(ctx, r.message)
                return Result.success()
            }
            last = r.message
        }
        DailyPlan.setResult(ctx, "$last, will try again")
        return Result.success()
    }
}
