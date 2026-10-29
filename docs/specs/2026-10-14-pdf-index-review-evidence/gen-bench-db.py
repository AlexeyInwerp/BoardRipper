import sqlite3, random, time, sys
random.seed(1)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 60000
db = sqlite3.connect("bench.db")
db.executescript("""
PRAGMA journal_mode=wal; PRAGMA synchronous=off;
CREATE TABLE IF NOT EXISTS pdf_pages (rowid INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, page_num INTEGER NOT NULL, text_content TEXT NOT NULL, UNIQUE(file_id,page_num));
CREATE INDEX IF NOT EXISTS idx_pages_file ON pdf_pages(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS pdf_text USING fts5(text_content, content='pdf_pages', content_rowid='rowid', tokenize='porter unicode61', prefix='2 3 4');
CREATE TRIGGER IF NOT EXISTS pdf_pages_ai AFTER INSERT ON pdf_pages BEGIN INSERT INTO pdf_text(rowid, text_content) VALUES (new.rowid, new.text_content); END;
""")
prefixes = ["PP","PM","SMC","LCD","USB","PCIE","DDR","CPU","GPU","SPI","I2C","SMBUS","ACC","AUD","BT","WLAN","CAM","TP","LED","FAN"]
suffix = ["EN","L","R","P","N","SDA","SCL","CLK","RST","PWR","G3H","S0","S3","S5","INT","DET"]
parts = ["AOZ5332QI","TPS51980A","ISL95870","MAX17051","NCP81239","SN74LVC","LM358","TXS0108","U8900","R8912","C8800","Q7100","L7000","D5100","J4500","FL2000","BQ24780","CD3215","CD3217","APL1098","SMC","PMIC"]
words = ["connector","schematic","sheet","power","sense","voltage","current","gnd","vcc","ppbus","battery","charger","backlight","display","thermal","sensor","note","page","revision","confidential","apple","inc","title","date","drawn","checked","ohm","uf","nf","pf","mohm","resistor","capacitor","inductor","diode","transistor"]
def page():
    toks = []
    for _ in range(random.randint(150, 400)):
        r = random.random()
        if r < 0.35: toks.append(random.choice(prefixes)+random.choice(["1V8","3V3","5V0","0V9","1V2","12V","VCORE","GPU","MEM"])+"_"+random.choice(suffix))
        elif r < 0.5: toks.append(random.choice(parts))
        elif r < 0.65: toks.append(random.choice("RCLDQUJ")+str(random.randint(1,9999)))
        elif r < 0.75: toks.append(str(random.randint(0,999)))
        else: toks.append(random.choice(words))
    return "\n".join(" ".join(toks[i:i+8]) for i in range(0, len(toks), 8))
t=time.time(); fid=1; pn=1; batch=[]
for i in range(N):
    batch.append((fid, pn, page())); pn += 1
    if pn > random.randint(5, 120): fid += 1; pn = 1
    if len(batch) >= 2000:
        db.executemany("INSERT INTO pdf_pages(file_id,page_num,text_content) VALUES(?,?,?)", batch); db.commit(); batch=[]
        print(i+1, round(time.time()-t), "s", flush=True)
if batch: db.executemany("INSERT INTO pdf_pages(file_id,page_num,text_content) VALUES(?,?,?)", batch); db.commit()
db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
print("done", N, "pages", fid, "files", round(time.time()-t), "s")
