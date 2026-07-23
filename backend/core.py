import requests
import json
import io
import math
import random
from datetime import datetime
from typing import Dict, Tuple, Optional

import google.generativeai as genai
import gspread
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

# --- LOCATION & DISTANCE SERVICES ---
def parse_pincode(pincode: str) -> Tuple[str, str, str, str]:
    region_code = pincode[:3] if len(pincode) == 6 else "000"
    taluka_code = pincode[3:] if len(pincode) == 6 else "000"
    
    # 1. Bulletproof Offline Fallback (Specifically mapping 201 to Ghaziabad)
    if region_code == "201":
        state_code = "UP"
        dist_code = "GHZ"
        location_name = "Ghaziabad, Uttar Pradesh"
    else:
        state_code = "IND"
        dist_code = f"ZN{region_code}"
        location_name = f"Zone {region_code} (Offline)"
    
    try:
        # Increased timeout to 5 seconds to reduce API failures
        res = requests.get(f"https://api.postalpincode.in/pincode/{pincode}", timeout=5)
        if res.status_code == 200:
            data = res.json()
            if data[0]["Status"] == "Success":
                po = data[0]["PostOffice"][0]
                state_code = po["State"][:2].upper()
                
                dist_name = po["District"].upper()
                # 2. Force "GHZ" instead of the API's default "GHA"
                dist_code = "GHZ" if dist_name == "GHAZIABAD" else dist_name[:3]
                
                location_name = f"{po['District']}, {po['State']}"
    except Exception:
        pass
        
    return state_code, dist_code, taluka_code, location_name


def get_next_sequential_id(state_code: str, dist_code: str, taluka_code: str, db_config: dict) -> str:
    """
    Reads the Google Sheet to find the latest ID in a specific Taluka's 1000-block.
    Example: Taluka '014' creates a block from 14000 to 14999.
    """
    series_start = int(taluka_code) * 1000
    prefix = f"{state_code}-{dist_code}-"
    
    creds = get_google_credentials(db_config["gcp_credentials"])
    client = gspread.authorize(creds)
    sheet = client.open_by_key(db_config["sheet_id"]).worksheet("Schools")
    
    try:
        # col_values(1) gets all existing School IDs from Column A
        existing_ids = sheet.col_values(1)
    except Exception:
        existing_ids = []
        
    # Default to 1 less than the start, so the first school gets sequence ending in '000'
    max_in_series = series_start - 1 
    
    for eid in existing_ids:
        if eid.startswith(prefix):
            try:
                num_val = int(eid.replace(prefix, ""))
                # Verify the ID falls within this specific Taluka's capacity block of 1000
                if series_start <= num_val < series_start + 1000:
                    if num_val > max_in_series:
                        max_in_series = num_val
            except ValueError:
                continue
                
    # Increment the highest found number by 1
    next_num = max_in_series + 1
    return f"{prefix}{next_num}"

def get_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371e3
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi/2.0)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda/2.0)**2
    return R * (2 * math.atan2(math.sqrt(a), math.sqrt(1-a)))

# --- AI ABSTRACTION & SCORING LAYER ---
def analyze_image(image_bytes: bytes, remarks: str, audio_bytes: bytes, audio_mime: str, api_key: str) -> Optional[Dict]:
    prompt = f"""
    You are an administrative washroom inspector. Analyze this photo. 
    The inspector added these written remarks: "{remarks}".
    If an audio file is attached, listen to the inspector's spoken notes and factor them heavily into your assessment.
    
    Calculate baseline scores (Floor max 10.0, Pan max 10.0, Wall max 10.0) and identify penalties.
    
    CRITICAL TRIAGE RULE: Set triage level > 0 ONLY IF the washroom is COMPLETELY UNUSABLE (e.g., severe biohazards, completely destroyed infrastructure, no water access at all making it physically impossible to use). If it is usable but dirty or has minor issues, triage MUST be 0.
    
    Provide detailed reasoning and actionable solutions for EVERY parameter.
    Translate ALL reasons and solutions into English, Hindi, and Marathi.
    
    Return STRICTLY a JSON object. No markdown, no formatting blocks.
    {{
      "context": {{ "toilet_type": "squat or western", "door_in_frame": true }},
      "baseline_scores": {{
        "floor_cleanliness": {{ "score": 8.0, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }},
        "pan_cleanliness": {{ "score": 7.0, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }},
        "wall_upkeep": {{ "score": 9.0, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }}
      }},
      "penalties": {{
        "biospill_present": {{ "active": false, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }},
        "standing_water": {{ "active": true, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }},
        "broken_hardware": {{ "active": false, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }},
        "broken_latch": {{ "active": false, "reason_en": "...", "reason_hi": "...", "reason_mr": "...", "solution_en": "...", "solution_hi": "...", "solution_mr": "..." }}
      }},
      "triage": {{ 
        "level": 0, 
        "reason_en": "...", "reason_hi": "...", "reason_mr": "...", 
        "solution_en": "...", "solution_hi": "...", "solution_mr": "..."
      }},
      "overall_summary": {{
        "en": "...", "hi": "...", "mr": "..."
      }}
    }}
    """
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel('gemini-3.6-flash')
        
        contents = [prompt, {"mime_type": "image/png", "data": image_bytes}]
        if audio_bytes:
            contents.append({"mime_type": audio_mime, "data": audio_bytes})
            
        response = model.generate_content(contents)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception as e:
        print(f"AI API Error: {e}")
        return None

def calculate_final_score(ai_result: Dict) -> Dict:
    b = ai_result.get("baseline_scores", {})
    p = ai_result.get("penalties", {})
    c = ai_result.get("context", {})
    t = ai_result.get("triage", {})
    
    # REBALANCED WEIGHTS: Pan/Bowl heavily prioritized
    floor_score = b.get("floor_cleanliness", {}).get("score", 0) * 0.30
    pan_score = b.get("pan_cleanliness", {}).get("score", 0) * 0.50
    wall_score = b.get("wall_upkeep", {}).get("score", 0) * 0.20
    baseline_total = floor_score + pan_score + wall_score
    
    # REBALANCED PENALTIES: Revised deductions for Bio-spills & Water
    penalty_total = 0.0
    if p.get("biospill_present", {}).get("active"): penalty_total += 3.0
    if p.get("standing_water", {}).get("active"): penalty_total += 2.5
    if p.get("broken_hardware", {}).get("active"): penalty_total += 1.0
    if p.get("broken_latch", {}).get("active") and c.get("door_in_frame"): penalty_total += 1.0
    
    raw_score = baseline_total - penalty_total
    final_score = raw_score
    
    # TRIAGE CAPPING
    level = t.get("level", 0)
    if level == 1: final_score = min(raw_score, 3.0)
    elif level == 2: final_score = min(raw_score, 1.0)
    elif level == 3: final_score = 0.0
    
    final_score = max(0.0, min(10.0, final_score))
    final_score = round(final_score, 1)
    
    grade = 'F'
    if final_score >= 8.5: grade = 'A'
    elif final_score >= 7.0: grade = 'B'
    elif final_score >= 4.0: grade = 'C'
    elif final_score > 1.0: grade = 'D'
    
    return {"score": final_score, "grade": grade, "baseline_total": round(baseline_total, 2), "penalty_total": round(penalty_total, 2)}

# --- DATABASE & STORAGE LAYER ---
def get_google_credentials(oauth_info: dict):
    scopes = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    return Credentials(
        token=oauth_info["token"], refresh_token=oauth_info["refresh_token"],
        token_uri=oauth_info["token_uri"], client_id=oauth_info["client_id"],
        client_secret=oauth_info["client_secret"], scopes=scopes
    )

def verify_school(school_id: str, passcode: str, db_config: dict) -> bool:
    return get_school_details(school_id, passcode, db_config) is not None

def get_school_details(school_id: str, passcode: str, db_config: dict) -> Optional[Dict]:
    creds = get_google_credentials(db_config["gcp_credentials"])
    client = gspread.authorize(creds)
    sheet = client.open_by_key(db_config["sheet_id"]).worksheet("Schools")
    try:
        cell = sheet.find(school_id)
        row_values = sheet.row_values(cell.row)
        if len(row_values) >= 5 and str(row_values[4]) == str(passcode):
            return {"id": row_values[0], "name": row_values[1], "lat": float(row_values[2]), "lng": float(row_values[3])}
        return None
    except Exception:
        return None

def register_school_db(school_id: str, name: str, lat: float, lng: float, db_config: dict) -> str:
    passcode = str(random.randint(1000, 9999))
    creds = get_google_credentials(db_config["gcp_credentials"])
    client = gspread.authorize(creds)
    sheet = client.open_by_key(db_config["sheet_id"]).worksheet("Schools")
    sheet.append_row([school_id, name, lat, lng, passcode])
    return passcode

def save_audit(school_id: str, unit: int, image_bytes: bytes, remarks: str, ai_result: dict, scoring_result: dict, db_config: dict) -> bool:
    creds = get_google_credentials(db_config["gcp_credentials"])
    drive_service = build('drive', 'v3', credentials=creds)
    
    # 1. COLLISION-PROOF NAMING (Includes Seconds & Unit)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    base_file_name = f"{school_id}_{ts}_Unit{unit}"
    
    # 2. SAVE IMAGE (PNG format)
    img_metadata = {'name': f"{base_file_name}.png", 'parents': [db_config["folder_id"]]}
    img_media = MediaIoBaseUpload(io.BytesIO(image_bytes), mimetype='image/png', resumable=True)
    img_file = drive_service.files().create(body=img_metadata, media_body=img_media, fields='id, webViewLink').execute()
    image_link = img_file.get('webViewLink')

    # 3. SAVE NEAT JSON REPORT (ensure_ascii=False fixes the Unicode issue)
    report_data = {
        "metadata": {"school_id": school_id, "unit": unit, "timestamp": ts, "remarks": remarks},
        "scoring": scoring_result,
        "ai_analysis": ai_result
    }
    report_bytes = json.dumps(report_data, indent=2, ensure_ascii=False).encode('utf-8')
    rep_metadata = {'name': f"{base_file_name}_Report.json", 'parents': [db_config["folder_id"]]}
    rep_media = MediaIoBaseUpload(io.BytesIO(report_bytes), mimetype='application/json; charset=utf-8', resumable=True)
    rep_file = drive_service.files().create(body=rep_metadata, media_body=rep_media, fields='id, webViewLink').execute()
    report_link = rep_file.get('webViewLink')
    
    # 4. UPDATE SHEETS
    client = gspread.authorize(creds)
    sheet = client.open_by_key(db_config["sheet_id"]).worksheet("Submissions") 
    
    score = scoring_result["score"]
    row = [
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"), school_id, unit,
        score, scoring_result["grade"], ai_result.get("triage", {}).get("level", 0),
        ai_result.get("overall_summary", {}).get("en", ""), image_link, report_link, remarks
    ]
    
    res = sheet.append_row(row)
    
    # 5. GENERATE HEATMAP GRADIENT IN SHEETS (Red -> Yellow -> Green)
    try:
        updated_range = res.get('updates', {}).get('updatedRange', '')
        if updated_range:
            row_idx = updated_range.split('!')[1].split(':')[0][1:] 
            
            if score >= 5.0:
                r, g, b = (10.0 - score) / 5.0, 1.0, 0.0 # Yellow shifting to Green
            else:
                r, g, b = 1.0, score / 5.0, 0.0 # Red shifting to Yellow
                
            sheet.format(f"D{row_idx}", {
                "backgroundColor": {
                    "red": r,
                    "green": g,
                    "blue": b
                }
            })
    except Exception as e:
        print(f"Heatmap formatting skipped: {e}")
        
    return True