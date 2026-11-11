//! Timezone-aware date handling for report filters and groupings. Weeks start on Monday.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Day,
    Week,
    Month,
}

impl Unit {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "day" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            _ => Err(AppError::Invalid(format!("Unknown time unit \"{value}\"."))),
        }
    }
}

pub fn parse_tz(name: &str) -> AppResult<Tz> {
    name.parse::<Tz>().map_err(|_| AppError::Invalid(format!("Unknown timezone \"{name}\".")))
}

pub fn parse_day(value: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| AppError::Invalid(format!("Invalid date \"{value}\". Use YYYY-MM-DD.")))
}

/// UTC milliseconds of local midnight; a midnight skipped by a DST change resolves to the first valid instant after it.
pub fn local_midnight_ms(tz: Tz, day: NaiveDate) -> i64 {
    let mut naive = day.and_hms_opt(0, 0, 0).expect("midnight is valid");
    for _ in 0..48 {
        match tz.from_local_datetime(&naive) {
            LocalResult::Single(t) => return t.timestamp_millis(),
            LocalResult::Ambiguous(a, _) => return a.timestamp_millis(),
            LocalResult::None => naive += Duration::minutes(30),
        }
    }
    Utc.from_utc_datetime(&naive).timestamp_millis()
}

pub fn local_day(tz: Tz, ms: i64) -> Option<NaiveDate> {
    DateTime::<Utc>::from_timestamp_millis(ms).map(|t| t.with_timezone(&tz).date_naive())
}

fn start_of_month(day: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(day.year(), day.month(), 1).expect("first of month is valid")
}

fn add_months(day: NaiveDate, months: i32) -> NaiveDate {
    let total = day.year() * 12 + day.month0() as i32 + months;
    NaiveDate::from_ymd_opt(total.div_euclid(12), total.rem_euclid(12) as u32 + 1, 1).expect("first of month is valid")
}

pub fn bucket_start(day: NaiveDate, unit: Unit) -> NaiveDate {
    match unit {
        Unit::Day => day,
        Unit::Week => day - Duration::days(day.weekday().num_days_from_monday() as i64),
        Unit::Month => start_of_month(day),
    }
}

/// Bucket label: the period's first day (YYYY-MM-DD), or YYYY-MM for months.
pub fn bucket_label(day: NaiveDate, unit: Unit) -> String {
    let start = bucket_start(day, unit);
    match unit {
        Unit::Month => start.format("%Y-%m").to_string(),
        _ => start.format("%Y-%m-%d").to_string(),
    }
}

/// First day of the window "last `amount` units", counting the current, partial period as one.
pub fn relative_start(today: NaiveDate, amount: u32, unit: Unit) -> NaiveDate {
    let back = amount.saturating_sub(1) as i64;
    match unit {
        Unit::Day => today - Duration::days(back),
        Unit::Week => bucket_start(today, Unit::Week) - Duration::weeks(back),
        Unit::Month => add_months(start_of_month(today), -(back as i32)),
    }
}

/// Parses Jira timestamps (ISO 8601 with or without offset) to UTC milliseconds.
pub fn parse_timestamp(value: &str) -> Option<i64> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(v) {
        return Some(t.timestamp_millis());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f%z", "%Y-%m-%dT%H:%M:%S%z"] {
        if let Ok(t) = DateTime::parse_from_str(v, fmt) {
            return Some(t.timestamp_millis());
        }
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(v, fmt) {
            return Some(Utc.from_utc_datetime(&t).timestamp_millis());
        }
    }
    None
}

/// Date-only attribute values: accepts YYYY-MM-DD with an optional time suffix.
pub fn parse_date_value(value: &str) -> Option<String> {
    let v = value.trim();
    let head = v.get(..10)?;
    NaiveDate::parse_from_str(head, "%Y-%m-%d").ok().map(|d| d.format("%Y-%m-%d").to_string())
}

pub fn format_local(ms: i64, tz: Tz) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&tz).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

pub fn format_iso(ms: i64, tz: Tz) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&tz).format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        .unwrap_or_default()
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    #[test]
    fn weeks_start_on_monday_and_months_cross_years() {
        assert_eq!(bucket_label(d("2024-03-10"), Unit::Week), "2024-03-04");
        assert_eq!(bucket_label(d("2024-03-11"), Unit::Week), "2024-03-11");
        assert_eq!(bucket_label(d("2024-01-31"), Unit::Month), "2024-01");
        assert_eq!(relative_start(d("2024-03-31"), 1, Unit::Month), d("2024-03-01"));
        assert_eq!(relative_start(d("2024-03-31"), 3, Unit::Month), d("2024-01-01"));
        assert_eq!(relative_start(d("2024-01-15"), 2, Unit::Month), d("2023-12-01"));
        assert_eq!(relative_start(d("2024-03-13"), 2, Unit::Week), d("2024-03-04"));
        assert_eq!(relative_start(d("2024-03-13"), 7, Unit::Day), d("2024-03-07"));
        assert_eq!(relative_start(d("2024-03-13"), 0, Unit::Day), d("2024-03-13"));
    }

    #[test]
    fn local_midnight_handles_dst_transitions() {
        let sydney: Tz = "Australia/Sydney".parse().unwrap();
        // Daylight time starts at 02:00 on 2024-10-06, so that midnight is still UTC+10 and the next is UTC+11.
        assert_eq!(local_midnight_ms(sydney, d("2024-10-06")), parse_timestamp("2024-10-05T14:00:00Z").unwrap());
        assert_eq!(local_midnight_ms(sydney, d("2024-10-07")), parse_timestamp("2024-10-06T13:00:00Z").unwrap());
        // 2024-04-07 ends daylight time; midnight is still UTC+11.
        assert_eq!(local_midnight_ms(sydney, d("2024-04-07")), parse_timestamp("2024-04-06T13:00:00Z").unwrap());
        // Santiago skips midnight at the start of daylight time.
        let santiago: Tz = "America/Santiago".parse().unwrap();
        let ms = local_midnight_ms(santiago, d("2024-09-08"));
        assert_eq!(local_day(santiago, ms), Some(d("2024-09-08")));
        assert_eq!(format_local(ms, santiago), "2024-09-08 01:00:00");
    }

    #[test]
    fn events_bucket_by_local_day_not_utc() {
        let sydney: Tz = "Australia/Sydney".parse().unwrap();
        let ms = parse_timestamp("2024-03-31T14:30:00.000Z").unwrap();
        assert_eq!(local_day(sydney, ms), Some(d("2024-04-01")));
        assert_eq!(bucket_label(local_day(sydney, ms).unwrap(), Unit::Month), "2024-04");
        assert_eq!(local_day(Tz::UTC, ms), Some(d("2024-03-31")));
    }

    #[test]
    fn parses_jira_timestamp_formats() {
        let want = parse_timestamp("2024-05-01T10:00:00Z").unwrap();
        assert_eq!(parse_timestamp("2024-05-01T10:00:00.000Z"), Some(want));
        assert_eq!(parse_timestamp("2024-05-01T20:00:00.000+1000"), Some(want));
        assert_eq!(parse_timestamp("2024-05-01T10:00:00.000"), Some(want));
        assert_eq!(parse_timestamp("not a date"), None);
        assert_eq!(parse_date_value("2024-05-01"), Some("2024-05-01".into()));
        assert_eq!(parse_date_value("2024-05-01T00:00:00"), Some("2024-05-01".into()));
        assert_eq!(parse_date_value("01/05/2024"), None);
    }
}
