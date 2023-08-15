use std::{
    fs::File,
    io::{BufReader, ErrorKind, Read},
    ops::Not,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{anyhow, Result};
use cookie_store::CookieStore;
use crossbeam_channel::{bounded, select, Receiver};
use env_logger::{Builder, Env};
use log::{debug, error, info, warn};
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use ureq::{self, AgentBuilder};

/// Create a channel to receive Ctrl-C events
fn ctrl_channel() -> Result<Receiver<()>, ctrlc::Error> {
    let (sender, receiver) = bounded(100);
    ctrlc::set_handler(move || {
        let _ = sender.send(());
    })?;

    Ok(receiver)
}

/// Struct containing the details to connect to application
#[derive(Debug)]
struct AppDetails {
    user: String,
    password: String,
    url: String,
}

impl AppDetails {
    /// Create a new QbitDetails struct from environment variables
    fn new() -> Self {
        let user = std::env::var("APPLICATION_USER")
            .expect("APPLICATION_USER environment variable must be set");
        let password = std::env::var("APPLICATION_PASSWORD")
            .expect("APPLICATION_PASSWORD environment variable must be set");
        let host = std::env::var("APPLICATION_HOST")
            .expect("APPLICATION_HOST environment variable must be set");

        let secure = std::env::var("QBITTORRENT_SECURE")
            .unwrap_or("".to_string())
            .trim()
            .is_empty()
            .not();

        let default_port = if secure { "443" } else { "80" };
        let port: u16 = std::env::var("APPLICATION_PORT")
            .unwrap_or(default_port.into())
            .parse()
            .expect("APPLICATION_PORT environment variable must be a number");

        let url = format!(
            "{}://{}:{}",
            if secure { "https" } else { "http" },
            host,
            port
        );

        Self {
            user,
            password,
            url,
        }
    }
}

/// Update the port in the application
///
/// # Arguments
///
/// * `agent` - [`ureq::Agent`] to connect to application
/// * `app` - AppDetails struct containing the details to connect to application
/// * `port_forwarded` - Path to the file containing the port to forward
fn update_port<P: AsRef<Path>>(
    agent: &ureq::Agent,
    app: &AppDetails,
    port_change_file: P,
) -> Result<()> {
    // Read the port from the file
    let mut forwarded_port = String::new();
    File::open(port_change_file)
        .map_err(|e| anyhow!(e))?
        .read_to_string(&mut forwarded_port)?;
    forwarded_port = forwarded_port.trim().to_string();
    info!("Updating application port to {forwarded_port}");

    // Set the preference
    let preference_endpoint = format!("{}/api/v2/app/setPreferences", app.url);
    match agent.post(&preference_endpoint).send_form(&[(
        "json",
        &ureq::json!({"listen_port": forwarded_port.trim()}).to_string(),
    )]) {
        Ok(r) => {
            debug!("Response: {:?}", r.into_string());
            info!(
                "Successfully updated application to port {}",
                forwarded_port
            )
        }
        Err(e) => {
            debug!("Response: {:?}", e);
            info!("Failed to update application to port {}", forwarded_port)
        }
    }

    Ok(())
}

/// Handle messages from the debounced file watcher
/// If the file is modified or created, update the port in application
///
/// # Arguments
///
/// * `port_forwarded` - Path to the file containing the port to forward
/// * `app` - QbitDetails struct containing the details to connect to
///   application
/// * `rx` - Receiver for the debounced file watcher
fn receive_msg_loop(
    agent: &ureq::Agent,
    port_forwarded: &PathBuf,
    app: &AppDetails,
    rx: Receiver<DebounceEventResult>,
) -> Result<()> {
    let ctrl_c_events = ctrl_channel()?;

    loop {
        // the select! macro provided by crossbeam will block until one of its arms (a
        // receiver channel) is ready
        select! {
            recv(rx) -> msg => {
                let collected_events = msg?
                    .map_err(|e| {
                    // fold the Vec of errors into a single string
                        let folded_err = e
                            .iter()
                            .map(|err| err.to_string())
                            .collect::<Vec<_>>()
                            .join("\n");
                    // return the error
                        anyhow!(folded_err)
                    })?
                    .iter()
                    .fold(false, |acc, event| {
                    // if any of the events are a modify or create, return true
                    // logically OR the accumulator with the result of the match
                        acc || match event.event.kind {
                            notify::EventKind::Modify(_) | notify::EventKind::Create(_) => true,
                            _ => false,
                        }
                    });
                if collected_events {
                    update_port(agent, &app, &port_forwarded)?;
                };
            }
            recv(ctrl_c_events) -> _ => {
                println!("\nReceived Ctrl-C, goodbye!");
                std::process::exit(0);
            }
        }
    }
}

trait AuthCookieJar {
    type Output;
    fn new_with_cookie_jar<P: AsRef<Path>>(
        qbit: &AppDetails,
        cookie_file: P,
    ) -> Result<Self::Output>;
}

impl AuthCookieJar for ureq::Agent {
    type Output = Self;
    fn new_with_cookie_jar<P: AsRef<Path>>(app: &AppDetails, cookie_file: P) -> Result<Self> {
        match File::open(cookie_file.as_ref()) {
            // the cookie file does not exist, attempt to prompt for username/password
            Err(e) if matches!(e.kind(), ErrorKind::NotFound) => {
                let agent = ureq::agent();
                let auth_endpoint = format!("{}/api/v2/auth/login", app.url);
                let res = agent
                    .post(&auth_endpoint)
                    .send_form(&[("username", &app.user), ("password", &app.password)])?;
                if res.status() != 200 {
                    return Err(anyhow!("Login request did not return 200."));
                } else {
                    info!("Login successful");
                }

                let mut file = File::create(cookie_file.as_ref())?;
                agent
                    .cookie_store()
                    .save_json(&mut file)
                    .map_err(|e| anyhow!(e))?;
                debug!("Saved cookie jar to {:?}", cookie_file.as_ref());

                Ok(agent)
            }
            // the cookie file does exist, load an agent with that file as the cookie jar
            Ok(cookie_file) => {
                let read = BufReader::new(cookie_file);
                let cookie_jar = CookieStore::load_json(read).unwrap();
                let agent = AgentBuilder::new()
                    .timeout_read(Duration::from_secs(5))
                    .timeout_write(Duration::from_secs(5))
                    .cookie_store(cookie_jar)
                    .build();
                Ok(agent)
            }
            // Something else went wrong, return the error
            Err(e) => {
                return Err(anyhow!(e));
            }
        }
    }
}

fn main() -> Result<()> {
    Builder::from_env(Env::default().default_filter_or("debug")).init();
    eprintln!("Starting gluetun-port-mgr");

    let port_forward_path =
        std::env::var("PORT_CHANGE_FILE").expect("PORT_CHANGE_FILE env var must be set");
    let qbit = AppDetails::new();

    let mut att = 0;
    let mut failures = 0;
    let mut time_since_last_failure = std::time::Instant::now();
    // loop forever
    loop {
        // create agent with a cookie store to handle authentication
        let agent = ureq::Agent::new_with_cookie_jar(&qbit, "cookies.json")?;
        let port_forwarded = match std::fs::canonicalize(&port_forward_path) {
            Ok(path) => path,
            Err(e) => match e.kind() {
                ErrorKind::NotFound => {
                    if att > 10 {
                        log::error!(
                            "Couldn't find file {:?} after 10 attempts",
                            &port_forward_path
                        );
                        std::process::exit(1);
                    }
                    warn!(
                        "Couldn't find file {:?}. Trying again in 10 seconds.",
                        &port_forward_path
                    );
                    std::thread::sleep(Duration::from_secs(10));
                    att += 1;
                    continue;
                }
                _ => {
                    error!("Error finding file {:?}: {:?}", port_forward_path, e);
                    std::process::exit(1);
                }
            },
        };

        // reset attempts counter if file exists after not existing
        att = 0;
        // setup debouncer
        let (tx, rx) = bounded(100);
        // no specific tickrate, max debounce time 2 seconds
        let mut debouncer = new_debouncer(Duration::from_secs(30), None, tx)
            .expect("failed to create notify event debouncer");
        debouncer
            .watcher()
            .watch(&*port_forwarded, RecursiveMode::NonRecursive)
            .expect("Failed to create watcher for port forwarded file");
        debouncer
            .cache()
            .add_root(port_forwarded.clone(), RecursiveMode::NonRecursive);

        info!("{port_forwarded:?} exists, watching for changes");
        // loop to handle debounced events, handle error cases
        if receive_msg_loop(&agent, &port_forwarded, &qbit, rx).is_err() {
            // if we get an error, and the last failure was more than 24 hours ago, reset
            // the failure counter. Why 24 hours? Because if we're failing, it's probably
            // because we lost authentication to the application, so we just need to re-auth
            if time_since_last_failure.elapsed().as_secs() > 86_400 {
                failures = 0;
            }
            // increment the failure counter, and set the time of the last failure to now
            failures += 1;
            time_since_last_failure = std::time::Instant::now();
            // if we've failed more than 10 times, exit
            if failures > 10 {
                error!("Failed to update port 10 times, process is unhealthy. Exiting.");
                std::process::exit(1);
            }
        };
    }
}
