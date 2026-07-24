import base64
import random
import os
import json
import traceback  # <-- Added missing import to prevent crashes
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv
import core 

load_dotenv()
app = FastAPI(title="Washroom Portal API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],  
    allow_headers=["*"],  
)

def get_db_config():
    return {
        "gcp_credentials": json.loads(os.getenv("GOOGLE_OAUTH_JSON")),
        "sheet_id": os.getenv("GOOGLE_SHEET_ID"),
        "folder_id": os.getenv("GOOGLE_DRIVE_FOLDER_ID")
    }

class RegisterRequest(BaseModel):
    school_name: str
    pincode: str
    lat: float
    lng: float

class LoginRequest(BaseModel):
    school_id: str
    passcode: str

class AuditRequest(BaseModel):
    school_id: str
    passcode: str
    unit: int
    image: str
    lat: float
    lng: float
    remarks: str
    audio: Optional[str] = None 

@app.post("/api/register")
def register_school(req: RegisterRequest):
    if not req.pincode.isdigit() or len(req.pincode) != 6:
        raise HTTPException(status_code=400, detail="Invalid Pincode format")
        
    state_code, dist_code, taluka_code, loc_name = core.parse_pincode(req.pincode)
    
    try:
        db_config = get_db_config()
        
        # This function scans the Google Sheet and allocates the exact next number sequentially
        # Pincode 201014 -> Block 14000. First school: 14000, next: 14001, etc.
        new_id = core.get_next_sequential_id(state_code, dist_code, taluka_code, db_config)
        
        new_passcode = core.register_school_db(new_id, req.school_name, req.lat, req.lng, db_config)
        return {"status": "success", "school_id": new_id, "passcode": new_passcode, "location": loc_name}
        
    except Exception as e:
        print("\n=== REGISTRATION ERROR ===")
        traceback.print_exc()
        print("==========================\n")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify")
def verify_login(req: LoginRequest):
    if core.verify_school(req.school_id.upper(), req.passcode, get_db_config()):
        return {"status": "success"}
    raise HTTPException(status_code=401, detail="Invalid Credentials")

@app.post("/api/audit")
async def submit_audit(req: AuditRequest):
    db_config = get_db_config()
    school = core.get_school_details(req.school_id, req.passcode, db_config)
    if not school: raise HTTPException(status_code=401, detail="Invalid Credentials")
    
    distance = core.get_distance(school['lat'], school['lng'], req.lat, req.lng)
    if distance > 200: raise HTTPException(status_code=403, detail=f"GPS Check Failed: {int(distance)}m away.")
    
    try: 
        # Safely extract image bytes whether MIME is jpeg or png
        image_bytes = base64.b64decode(req.image.split(',')[1]) 
    except Exception: raise HTTPException(status_code=400, detail="Invalid image")

    audio_bytes = None
    audio_mime = "audio/webm"
    if req.audio:
        try:
            header, b64_data = req.audio.split(',', 1)
            audio_bytes = base64.b64decode(b64_data)
            if "mp4" in header: audio_mime = "audio/mp4"
            elif "wav" in header: audio_mime = "audio/wav"
        except Exception:
            pass 

    ai_result = core.analyze_image(image_bytes, req.remarks, audio_bytes, audio_mime, os.getenv("GEMINI_API_KEY"))
    if not ai_result: raise HTTPException(status_code=500, detail="AI Analysis failed")
        
    scoring_result = core.calculate_final_score(ai_result)
    
    core.save_audit(req.school_id, req.unit, image_bytes, req.remarks, ai_result, scoring_result, db_config)
    return {"unit": req.unit, "scoring": scoring_result, "ai_detail": ai_result}