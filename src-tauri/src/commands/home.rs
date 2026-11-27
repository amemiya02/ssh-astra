use std::sync::Mutex;
use std::time::Instant;

use tauri::Manager;

pub(crate) struct StartupMeasurement(Mutex<Option<Instant>>);

impl StartupMeasurement {
    pub(crate) fn new(start: Instant) -> Self {
        Self(Mutex::new(Some(start)))
    }
}

#[tauri::command]
pub fn home_first_paint(app: tauri::AppHandle) {
    if let Some(measurement) = app.try_state::<StartupMeasurement>() {
        if let Some(start) = measurement.0.lock().unwrap().take() {
            eprintln!(
                "SSHASTRA_HOME_FIRST_PAINT_MS={:.3}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
}
