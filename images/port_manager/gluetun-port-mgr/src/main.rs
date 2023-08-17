use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, ErrorKind, Read, Write},
    ops::Not,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{anyhow, Result};
use cookie_store::CookieStore;
use crossbeam_channel::{bounded, select, Receiver};
use log::{debug, error, info, warn, LevelFilter};
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use simplelog::{ColorChoice, ConfigBuilder, TermLogger, TerminalMode};
use ureq::{self, AgentBuilder, Error};

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
        let user = std::env::var("GTPM_APPLICATION_USER")
            .expect("GTPM_APPLICATION_USER environment variable must be set");
        let password = std::env::var("GTPM_APPLICATION_PASSWORD")
            .expect("GTPM_APPLICATION_PASSWORD environment variable must be set");
        let host = std::env::var("GTPM_APPLICATION_HOST")
            .expect("GTPM_APPLICATION_HOST environment variable must be set");

        let secure = std::env::var("GTPM_APPLICATION_SECURE")
            .unwrap_or("".to_string())
            .trim()
            .is_empty()
            .not();

        let default_port = if secure { "443" } else { "80" };
        let port: u16 = std::env::var("GTPM_APPLICATION_PORT")
            .unwrap_or(default_port.into())
            .parse()
            .expect("GTPM_APPLICATION_PORT environment variable must be a number");

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

fn get_settings<P: AsRef<Path>>(settings_path: P) -> Result<HashMap<String, String>> {
    let settings_file = File::open(settings_path)?;
    // parse this dotenv file into a HashMap
    let settings_reader = BufReader::new(settings_file);
    let mut settings: HashMap<String, String> = HashMap::new();
    for line in settings_reader.lines() {
        let line = line?;
        if line.starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = line.split('=').collect();
        let key = cols[0];
        let value = cols[1];
        settings.insert(key.to_string(), value.to_string());
    }
    Ok(settings)
}

// Process a single line in the conf file
fn process_line<'a>(
    line: &'a str,
    mut old_port_number: &'a str,
    new_port_number: &str,
    vpn_interface: &str,
    vxlan_ip_network: &str,
) -> Result<()> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    let (name, ip, ports) = (cols[0], cols[1], cols[2]);

    let port_strings: Vec<&str> = ports.split(',').collect();
    for port_string in port_strings {
        let port_parts: Vec<&str> = port_string.split(':').collect();
        let (port_type, port_number) = (port_parts[0], port_parts[1]);

        // if we didn't read a port number, use the port number that was placed there by
        // the Pod Gateway
        if old_port_number.is_empty() {
            old_port_number = port_number;
        }
        debug!("IP: {ip} , NAME: {name} , PORT: {port_number} , TYPE: {port_type}");

        // Add the new iptables rules
        append_iptables_rules(
            port_type,
            vpn_interface,
            new_port_number,
            vxlan_ip_network,
            ip,
        )
        .map_err(|e| {
            error!("Failed to append new iptables rules: {e:?}");
            e
        })?;
        // Delete the old iptables rules
        delete_iptables_rules(
            port_type,
            vpn_interface,
            old_port_number,
            vxlan_ip_network,
            ip,
        )
        .map_err(|e| {
            error!("Failed to delete iptables rules: {e:?}");
            e
        })?;
    }

    Ok(())
}

enum IptablesAction {
    Append,
    Delete,
}

fn append_iptables_rules(
    port_type: &str,
    vpn_interface: &str,
    new_port_number: &str,
    vxlan_ip_network: &str,
    ip: &str,
) -> Result<()> {
    manage_ip_tables(
        IptablesAction::Append,
        port_type,
        vpn_interface,
        new_port_number,
        vxlan_ip_network,
        ip,
    )?;

    Ok(())
}

fn delete_iptables_rules(
    port_type: &str,
    vpn_interface: &str,
    old_port_number: &str,
    vxlan_ip_network: &str,
    ip: &str,
) -> Result<()> {
    manage_ip_tables(
        IptablesAction::Delete,
        port_type,
        vpn_interface,
        old_port_number,
        vxlan_ip_network,
        ip,
    )?;

    Ok(())
}

/// This Rust code is a wrapper around a Linux system command named iptables.
/// The iptables command is used for setting up, maintaining, and inspecting the
/// tables of IP packet filter rules in the Linux kernel. Here's a breakdown of
/// the command and arguments:
///
/// #### NAT Pre-routing Command
///
/// * `Command::new("iptables")` is where the iptables command is specified.
/// * .args(&[ ... ]) is a list of arguments or flags passed to the iptables
///   command.
/// * `iptables -t nat` specifies that we're dealing with Network Address
///   Translation (NAT) rules.
/// * `-A/-D PREROUTING` specifies that the rule must be appended (`-A`) or
///   deleted (`-D`) from the PREROUTING chain. The PREROUTING chain is where
///   the packets will go when they just arrive at the network interface.
/// * `-p port_type` specifies the protocol of the rule or of the packet to
///   check.
/// * `-i vpn_interface` specifies the name of an interface via which a packet
///   is going to be received (-i for input)
/// * `--dport old_port_number` specifies the destination port or port range
///   specification (--dport for destination port)/ This is the port to which
///   packets are sent.
/// * `-j DNAT` specifies the target of the rule; i.e., what to do if the packet
///   matches it. In this case, DNAT stands for Destination NAT.
/// * `--to-destination &format!("{}.{}:{}", vxlan_ip_network, ip,
///   old_port_number)` provides the new destination for the DNAT target, i.e.,
///   where the packet will be redirected if it matches the rule.\
///
/// #### FORWARD Command
///
/// * `Command::new("iptables")` specifies the iptables command.
/// * `.args(&[ ... ])` provides a list of arguments or flags to pass to the
///   iptables command.
/// * `-A/-D FORWARD` indicates that a rule must be appended (`-A`) or deleted
///   (`-D`) from the FORWARD chain. The FORWARD chain handles packets that are
///   being routed through the current device.
/// * `-p port_type` specifies the protocol of the rule or the packet to check.
///   The value for the port_type variable is set earlier in the program.
/// * `-d &format!("{}.{}", vxlan_ip_network, ip)` is specifying the network
///   destination address to use with content from the vxlan_ip_network and ip
///   variables.
/// * `--dport port_number` specifies the destination port or port range
///   specification. This is the port to which packets are sent.
/// * `-m state` matches a state. This means the rule only applies to packets
///   that match this state.
/// * `--state NEW,ESTABLISHED,RELATED` specifies that the packet's connection
///   tracking state should be one of the three: NEW (a new, not yet
///   acknowledged packet), ESTABLISHED (an acknowledged connection), or RELATED
///   (a packet that starts a new connection, but is associated with an existing
///   connection).
/// * `-j ACCEPT` specifies the target of the rule, in this case, ACCEPT. This
///   means if a packet matches the rule, it will be accepted and won't be
///   processed by any other rules in the chain.
fn manage_ip_tables(
    action: IptablesAction,
    port_type: &str,
    vpn_interface: &str,
    port_number: &str,
    vxlan_ip_network: &str,
    ip: &str,
) -> Result<()> {
    let action_flag = match action {
        IptablesAction::Append => "-A",
        IptablesAction::Delete => "-D",
    };

    Command::new("iptables")
        .args(&[
            "-t",
            "nat",
            action_flag,
            "PREROUTING",
            "-p",
            port_type,
            "-i",
            vpn_interface,
            "--dport",
            port_number.to_string().as_ref(),
            "-j",
            "DNAT",
            "--to-destination",
            &format!("{}.{}:{}", vxlan_ip_network, ip, port_number),
        ])
        .output()?;

    Command::new("iptables")
        .args(&[
            action_flag,
            "FORWARD",
            "-p",
            port_type,
            "-d",
            &format!("{}.{}", vxlan_ip_network, ip),
            "--dport",
            port_number.to_string().as_ref(),
            "-m",
            "state",
            "--state",
            "NEW,ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        ])
        .output()?;

    Ok(())
}

/// Update the iptables rules to reflect the new forwarded port
fn update_ip_tables(new_port_number: &str) -> Result<()> {
    info!("Updating iptables rules");
    let settings = get_settings("/config/settings.sh").map_err(|e| {
        error!("Failed to get settings file");
        e
    })?;

    // read the VXLAN IP network from the Pod Gateway settings file, or use the
    // default 172.16.0
    let vxlan_ip_network = settings
        .get("VXLAN_IP_NETWORK")
        .map(String::as_str)
        .unwrap_or_else(|| "172.16.0");

    // read the VPN interface from the Pod Gateway settings file, or use the default
    // tun0
    let vpn_interface = settings
        .get("VPN_INTERFACE")
        .map(String::as_str)
        .unwrap_or_else(|| "tun0");

    debug!("VXLAN IP Network: {}", vxlan_ip_network);
    debug!("VPN Interface: {}", vpn_interface);

    // open the port file we saved the last port number to so we can compare it to
    // the new port number
    let mut old_port_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open("/tmp/last_port_forward")
        .map_err(|e| {
            error!("Failed to open last port forward file");
            e
        })?;

    // read the old port number from the file
    let mut old_port_number = String::new();
    old_port_file.read_to_string(&mut old_port_number)?;
    let old_port_number = old_port_number.trim();

    // If the port hasn't changed, don't do anything
    if old_port_number == new_port_number {
        return Ok(());
    }

    let nat_conf_file = File::open(&"/config/nat.conf")?;
    let nat_conf_reader = BufReader::new(nat_conf_file);
    for line in nat_conf_reader.lines() {
        let line = line.expect("Failed to read line in nat.conf");
        if line.starts_with('#') {
            continue;
        }
        process_line(
            &line,
            old_port_number,
            new_port_number,
            vxlan_ip_network,
            vpn_interface,
        )
        .map_err(|e| {
            error!(
                "Failed to process line in nat.conf: {e:?}.\nLine: {line}, Old Port: \
                 {old_port_number}, New Port: {new_port_number}, VXLAN IP Network: \
                 {vxlan_ip_network}, VPN Interface: {vpn_interface}"
            );
            e
        })?;
    }

    write!(old_port_file, "{}", new_port_number)?;
    info!("Successfully updated iptables rules");
    Ok(())
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
    update_ip_tables(&forwarded_port)?;
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
        app: &AppDetails,
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

                let res = loop {
                    match agent
                        .post(&auth_endpoint)
                        .send_form(&[("username", &app.user), ("password", &app.password)])
                    {
                        Ok(r) => break r,
                        Err(e) => match e {
                            Error::Status(u16, response) => {
                                if u16 == 403 {
                                    error!("Invalid username or password");
                                    std::process::exit(1);
                                } else {
                                    error!(
                                        "Unable to connect to application, sleeping for 10 \
                                         seconds: {:?}",
                                        response.into_string()?
                                    );
                                    std::thread::sleep(Duration::from_secs(10));
                                }
                            }
                            Error::Transport(err) => {
                                error!(
                                    "Unable to connect to application, sleeping for 10 seconds: \
                                     {:?}",
                                    err
                                );
                                std::thread::sleep(Duration::from_secs(10));
                            }
                        },
                    };
                };

                info!("Login successful, {}", res.into_string()?);

                let mut file = File::create(cookie_file.as_ref())
                    .map_err(|e| anyhow!("Unable to create cookie jar file {e}"))?;
                agent
                    .cookie_store()
                    .save_json(&mut file)
                    .map_err(|e| anyhow!("Unable to save cookie store file: {e}"))?;
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
                return Err(anyhow!(
                    "Something else when wrong while opening the cookie jar file: {e}"
                ));
            }
        }
    }
}

fn main() -> Result<()> {
    unsafe {
        TermLogger::init(
            LevelFilter::Debug,
            ConfigBuilder::new()
                .set_time_offset_to_local()
                .map_err(|e| {
                    eprintln!("Failed to set time offset to local");
                    e
                })
                .unwrap_unchecked()
                .build(),
            TerminalMode::Stderr,
            ColorChoice::Auto,
        )
        .unwrap();
    }
    info!("Starting gluetun-port-mgr");

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
        let mut debouncer = new_debouncer(Duration::from_secs(30), None, tx).map_err(|e| {
            error!("Failed to create notify event debouncer: {e:?}");
            e
        })?;
        debouncer
            .watcher()
            .watch(&*port_forwarded, RecursiveMode::NonRecursive)
            .map_err(|e| {
                error!("Failed to create watcher for port forwarded file: {e:?}");
                e
            })?;
        debouncer
            .cache()
            .add_root(port_forwarded.clone(), RecursiveMode::NonRecursive);

        info!("{port_forwarded:?} exists, watching for changes");

        // update the port in the application on startup to ensure it's correct
        update_port(&agent, &qbit, &port_forwarded).map_err(|e| {
            error!("Failed to update port on startup: {e:?}");
            e
        })?;

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
