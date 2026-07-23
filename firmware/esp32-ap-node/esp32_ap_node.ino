/*
  FloorSense ESP32 AP node firmware.

  Runs a WiFi SoftAP with a captive portal that redirects joining
  devices to this project's existing consent page, then reports
  join/leave/signal_reading presence events to the FloorSense
  backend's POST /hardware/events endpoint.

  NOT compiled or hardware-tested in this environment - no ESP32 board
  or Arduino/ESP-IDF toolchain is available here. Read README.md
  before flashing; your own build+flash+test is the real verification.
*/

#include <WiFi.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <esp_wifi.h>

// ---- Configuration: edit every value below before flashing ----
const char *AP_SSID = "FloorSense-Guest";
const char *AP_PASSWORD = ""; // empty string = open network, no password
const char *BACKEND_URL = "http://192.168.4.2:3000"; // machine running @floorsense/owner-portal
const char *CONSENT_PORTAL_URL = "http://192.168.4.2:3001"; // machine running @floorsense/captive-portal
const char *VENUE_ID = "REPLACE_WITH_VENUE_ID"; // from GET /venues while logged in as this venue's owner
const char *HARDWARE_TOKEN = "REPLACE_WITH_HARDWARE_TOKEN"; // same response, hardwareToken field
const char *AP_NODE_ID = "REPLACE_WITH_AP_NODE_ID"; // must already exist for this venue (create it on the dashboard first)
const unsigned long SIGNAL_READING_INTERVAL_MS = 5000;
// ---- End configuration ----

DNSServer dnsServer;
WebServer webServer(80);
const byte DNS_PORT = 53;
IPAddress apIP(192, 168, 4, 1);

unsigned long lastSignalReadingAt = 0;

String macToString(const uint8_t *mac) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

String jsonEscape(const String &value) {
  String out;
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out;
}

bool postHardwareEvent(const String &deviceMac, const String &eventType, int rssi, bool includeRssi) {
  HTTPClient http;
  String url = String(BACKEND_URL) + "/hardware/events";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String body = "{";
  body += "\"venueId\":\"" + jsonEscape(String(VENUE_ID)) + "\",";
  body += "\"hardwareToken\":\"" + jsonEscape(String(HARDWARE_TOKEN)) + "\",";
  body += "\"apNodeId\":\"" + jsonEscape(String(AP_NODE_ID)) + "\",";
  body += "\"deviceMac\":\"" + jsonEscape(deviceMac) + "\",";
  body += "\"eventType\":\"" + eventType + "\"";
  if (includeRssi) {
    body += ",\"rssi\":" + String(rssi);
  }
  body += "}";

  int status = http.POST(body);
  if (status <= 0) {
    Serial.printf("Hardware event POST failed: %s\n", http.errorToString(status).c_str());
    http.end();
    return false;
  }
  if (status >= 300) {
    Serial.printf("Hardware event rejected: HTTP %d - %s\n", status, http.getString().c_str());
  }
  http.end();
  return status >= 200 && status < 300;
}

// ARDUINO_EVENT_WIFI_AP_STACONNECTED/_STADISCONNECTED are the event names on
// current Arduino-ESP32 core versions (2.x+). Older core versions used
// SYSTEM_EVENT_AP_STACONNECTED/_STADISCONNECTED instead - if this fails to
// compile, check your installed core version and rename these two events.
void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_AP_STACONNECTED) {
    String mac = macToString(info.wifi_ap_staconnected.mac);
    Serial.printf("Station joined: %s\n", mac.c_str());
    postHardwareEvent(mac, "join", 0, false);
  } else if (event == ARDUINO_EVENT_WIFI_AP_STADISCONNECTED) {
    String mac = macToString(info.wifi_ap_stadisconnected.mac);
    Serial.printf("Station left: %s\n", mac.c_str());
    postHardwareEvent(mac, "leave", 0, false);
  }
}

// Redirects every captive-portal-detection probe (and anything unrecognized)
// to the consent page, passing the connecting device's raw MAC - the
// captive-portal server hashes it server-side, this firmware never computes
// the hash itself. KNOWN LIMITATION: the Arduino WebServer API exposes the
// requester's IP but not its MAC directly, so this uses the first entry in
// the AP's station list. With exactly one device mid-onboarding at a time
// (the normal case - one visitor joins, sees the consent page, accepts) this
// is correct. If multiple devices are simultaneously mid-redirect before
// either has completed consent, this simple approach can attach the wrong
// MAC to that particular redirect. A more robust version would cross-reference
// the DHCP lease table by the requester's IP, which needs lower-level
// ESP-IDF calls this firmware intentionally avoids for verifiability.
void handleCaptivePortalRedirect() {
  wifi_sta_list_t staList;
  esp_wifi_ap_get_sta_list(&staList);

  String rawMac = "";
  if (staList.num > 0) {
    rawMac = macToString(staList.sta[0].mac);
  }

  String target = String(CONSENT_PORTAL_URL) + "/?rawMac=" + rawMac;
  webServer.sendHeader("Location", target, true);
  webServer.send(302, "text/plain", "");
}

void reportSignalReadings() {
  wifi_sta_list_t staList;
  esp_wifi_ap_get_sta_list(&staList);
  for (int i = 0; i < staList.num; i++) {
    String mac = macToString(staList.sta[i].mac);
    int rssi = staList.sta[i].rssi;
    postHardwareEvent(mac, "signal_reading", rssi, true);
  }
}

void setup() {
  Serial.begin(115200);

  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  WiFi.onEvent(onWifiEvent);

  dnsServer.start(DNS_PORT, "*", apIP);

  // Common OS captive-portal-detection probe paths, listed explicitly for
  // clarity - onNotFound already covers everything else the same way.
  webServer.on("/generate_204", handleCaptivePortalRedirect);
  webServer.on("/hotspot-detect.html", handleCaptivePortalRedirect);
  webServer.on("/ncsi.txt", handleCaptivePortalRedirect);
  webServer.on("/connecttest.txt", handleCaptivePortalRedirect);
  webServer.onNotFound(handleCaptivePortalRedirect);
  webServer.begin();

  Serial.println("FloorSense AP node ready.");
  Serial.print("SoftAP IP: ");
  Serial.println(WiFi.softAPIP());
}

void loop() {
  dnsServer.processNextRequest();
  webServer.handleClient();

  unsigned long now = millis();
  if (now - lastSignalReadingAt >= SIGNAL_READING_INTERVAL_MS) {
    lastSignalReadingAt = now;
    reportSignalReadings();
  }
}
