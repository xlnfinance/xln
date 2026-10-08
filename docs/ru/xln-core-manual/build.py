"""Render the source-backed xln manual. Run with the bundled PDF Python runtime."""
import json, math, os, re
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / 'content.json').read_text())
DETAILS = json.loads((ROOT / 'details.json').read_text())
OUT = ROOT.parent / 'output/pdf/xln-core-technical-manual.pdf'
FONTS = Path(os.environ.get('XLN_MANUAL_FONTS', str(ROOT / 'fonts')))
for name, file in [('Body','body.ttf'),('Bold','bold.ttf'),('Head','heading.ttf'),('Sub','subheading.ttf'),('Mono','mono.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(FONTS / file)))
pdfmetrics.registerFont(TTFont('Serif', '/System/Library/Fonts/Supplemental/Georgia Italic.ttf'))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='Bold', italic='Body', boldItalic='Bold')
W, H, M = 612, 792, 56
CW = W - M * 2
INK, MUTED, PAPER, LINE = map(HexColor, ['#0c1425','#52677f','#faf9f6','#d5d0c7'])
ORANGE, BLUE, GREEN, PURPLE = map(HexColor, ['#c7460a','#244ff0','#008568','#7a40dd'])
COLORS = {'R':ORANGE,'E':GREEN,'A':BLUE,'J':PURPLE,'gray':MUTED}
BOUNDS = []
OUT.parent.mkdir(parents=True, exist_ok=True)
C = canvas.Canvas(str(OUT), pagesize=(W,H), pageCompression=1)
C.setTitle('xln - техническое руководство по ядру')
C.setAuthor('xln | Source-based technical documentation')
C.setSubject('J/E/A, Runtime, consensus, RCPAN, settlement, disputes and recovery')

def text(x, top, value, size=10, font='Body', color=INK):
    C.setFillColor(color); C.setFont(font, size); C.drawString(x, H-top-size*.82, value)

def para(value, x, top, width=CW, size=11, font='Body', color=INK, leading=None):
    style = ParagraphStyle('p', fontName=font, fontSize=size, leading=leading or size*1.32, textColor=color)
    p = Paragraph(value, style); _, ht = p.wrap(width, H)
    p.drawOn(C, x, H-top-ht); BOUNDS.append((C.getPageNumber(), top, top+ht, value[:45]))
    return top+ht

def rule(top, color=LINE, width=.6):
    C.setStrokeColor(color); C.setLineWidth(width); C.line(M,H-top,W-M,H-top)

def rect(x, top, width, height, fill, stroke=None, radius=0):
    C.setFillColor(fill); C.setStrokeColor(stroke or fill); C.setLineWidth(.65)
    C.roundRect(x,H-top-height,width,height,radius,stroke=bool(stroke),fill=1)

def arrow(x1,y1,x2,y2,color=MUTED,label=None):
    C.setStrokeColor(color); C.setFillColor(color); C.setLineWidth(.8)
    C.line(x1,H-y1,x2,H-y2)
    angle=math.atan2(y2-y1,x2-x1); length=4.5
    path=C.beginPath(); path.moveTo(x2,H-y2)
    for offset in [-.5,.5]:
        path.lineTo(x2-length*math.cos(angle+offset), H-(y2-length*math.sin(angle+offset)))
    path.close(); C.drawPath(path,fill=1,stroke=0)
    if label: para(escape(label),min(x1,x2)+5,min(y1,y2)-13,abs(x2-x1)-10,size=8,color=MUTED)

def box(x,top,width,height,label,sub='',role='gray'):
    accent=COLORS.get(role,MUTED)
    rect(x,top,width,height,HexColor('#eef2f7'),accent)
    rect(x,top,3,height,accent)
    ptop=para(escape(label),x+10,top+8,width-20,size=9.7,font='Sub')
    if sub: ptop=para(escape(sub),x+10,ptop+4,width-20,size=8.4,color=MUTED)
    if ptop>top+height-2: raise ValueError(f'Diagram box overflow: {label}: {ptop-top:.1f}/{height}')

def diagram(d,top,fig):
    ht=d.get('height',170); kind=d['kind']; x=M+14; width=CW-28
    rect(M,top,CW,ht,HexColor('#ffffff'),LINE)
    if kind=='jea':
        cx=M+CW/2; box(cx-95,top+12,190,46,'J · Jurisdiction','Правила, finality и исполнение','J')
        bw=(width-36)/3; by=top+86
        for i,(label,sub,role) in enumerate([('E · Банк','Полномочия и reserves','E'),('A · Account','Баланс и обязательства','A'),('E · Человек','Полномочия и reserves','E')]):
            bx=x+i*(bw+18); box(bx,by,bw,46,label,sub,role)
            if i<2:
                arrow(bx+bw,by+23,bx+bw+18,by+23)
                arrow(bx+bw+18,by+23,bx+bw,by+23)
        arrow(cx-65,top+58,x+bw/2,by); arrow(cx+65,top+58,x+2*(bw+18)+bw/2,by)
        C.setDash(2,2); arrow(cx,top+58,cx,by,PURPLE); C.setDash()
    elif kind in ('flow','stack'):
        nodes=d['nodes']; vertical=kind=='stack'; n=len(nodes)
        gap=15 if vertical else 17; nw=width if vertical else (width-gap*(n-1))/n
        nh=(ht-30-gap*(n-1))/n if vertical else 65
        for i,node in enumerate(nodes):
            nx=x if vertical else x+i*(nw+gap); ny=top+15+i*(nh+gap) if vertical else top+(ht-nh)/2
            box(nx,ny,nw,nh,node[0],node[1] if len(node)>1 else '',node[2] if len(node)>2 else 'gray')
            if i<n-1:
                if vertical: arrow(nx+nw/2,ny+nh,nx+nw/2,ny+nh+gap)
                else: arrow(nx+nw,ny+nh/2,nx+nw+gap,ny+nh/2)
    elif kind=='sequence':
        lanes=d['lanes']; xs=[x+width*(i+.5)/len(lanes) for i in range(len(lanes))]
        for pos,name in zip(xs,lanes):
            box(pos-47,top+13,94,29,name,role='gray')
            C.setDash(2,3); C.setStrokeColor(LINE); C.line(pos,H-top-47,pos,H-top-ht+15); C.setDash()
        gap=(ht-78)/max(1,len(d['messages']))
        for i,(a,b,label) in enumerate(d['messages']):
            yy=top+66+i*gap; arrow(xs[a],yy,xs[b],yy,BLUE)
            para(escape(label),min(xs[a],xs[b])+6,yy-14,max(70,abs(xs[b]-xs[a])-12),size=8.5)
    elif kind=='tree':
        root=d['root']; children=d['children']; cx=M+CW/2
        box(cx-100,top+13,200,45,root[0],root[1],root[2] if len(root)>2 else 'gray')
        n=len(children); gap=12; bw=(width-gap*(n-1))/n; by=top+ht-69
        for i,node in enumerate(children):
            bx=x+i*(bw+gap); arrow(cx,top+58,bx+bw/2,by)
            box(bx,by,bw,53,node[0],node[1],node[2] if len(node)>2 else 'gray')
    elif kind=='range':
        left=x+22; right=x+width-22; yy=top+61; span=right-left
        for a,b,color,title in [(0,.25,GREEN,'Кредит Left'),(.25,.75,BLUE,'Collateral'),(.75,1,PURPLE,'Кредит Right')]:
            rect(left+span*a,yy,span*(b-a),23,color)
            para(title,left+span*a,yy-22,span*(b-a),size=9,color=MUTED)
        for p,label in [(0,'-L_left'),(.25,'0'),(.75,'C'),(1,'C + L_right')]:
            label_width=pdfmetrics.stringWidth(label,'Mono',9)
            lx=left if p==0 else right-label_width if p==1 else left+span*p-label_width/2
            text(lx,yy+31,label,9,'Mono')
        for i,(p,label) in enumerate(d.get('marks',[])):
            px=left+span*p; arrow(px,yy+78+i*20,px,yy+23,ORANGE)
            text(left+10,yy+78+i*20,label,9,'Body')
    elif kind in ('panels','mini'):
        items=d['items']; gap=12; bw=(width-gap*(len(items)-1))/len(items)
        inset=8 if kind=='mini' else 17
        for i,node in enumerate(items): box(x+i*(bw+gap),top+inset,bw,ht-inset*2,node[0],node[1],node[2] if len(node)>2 else 'gray')
    elif kind=='equation':
        label=d['formula']; size=min(10.2,(width-20)/pdfmetrics.stringWidth(label,'Mono',1))
        text(x+10,top+ht/2-5,label,size,'Mono',BLUE)
    elif kind=='balance':
        for i,(delta,label) in enumerate([(40,'До'),(20,'После')]):
            yy=top+7+i*24; text(x,yy+4,label,9,'Sub'); bx=x+48; span=width-48
            rect(bx,yy,span*delta/100,18,BLUE); rect(bx+span*delta/100,yy,span*(100-delta)/100,18,GREEN)
            text(bx+7,yy+4,f'Left {delta}',8.4,'Bold',HexColor('#ffffff'))
            text(bx+span*delta/100+7,yy+4,f'Right {100-delta}',8.4,'Bold',HexColor('#ffffff'))
    elif kind=='windows':
        for i,(label,start,end) in enumerate([('Source',0,0.55),('Target',0.25,0.85)]):
            yy=top+20+i*35; text(x,yy-5,label,9,'Sub'); bx=x+70; span=width-95
            C.setStrokeColor(LINE); C.line(bx,H-yy,bx+span,H-yy)
            rect(bx+span*start,yy-4,span*(end-start),8,PURPLE if i else GREEN)
            text(bx+span*start,yy+8,'S',8,'Mono'); text(bx+span*end-18,yy+8,'S+W',8,'Mono')
    elif kind=='timeline':
        axis=top+ht*.48; start=x+45; end=x+width-45; C.setStrokeColor(MUTED); C.line(start,H-axis,end,H-axis)
        for i,(label,sub) in enumerate(d['events']):
            px=start+(end-start)*i/(len(d['events'])-1); C.setFillColor(ORANGE); C.circle(px,H-axis,3.5,fill=1,stroke=0)
            para(escape(label),px-45,axis-40,90,size=9,font='Sub')
            para(escape(sub),px-45,axis+14,90,size=8.5,color=MUTED)
    else: raise ValueError(kind)
    label=f'FIG. {fig:02d}'
    rect(M,top+ht+6,58,13,INK); text(M+5,top+ht+8,label,8.3,'Mono',PAPER)
    end=para(escape(d['caption']),M+66,top+ht+7,CW-66,size=9,color=d.get('caption_color',MUTED))
    return max(end,top+ht+23)+12

def table(data,top):
    rows=[[Paragraph(escape(str(v)),ParagraphStyle('t',fontName='Bold' if i==0 else 'Body',fontSize=9.2,leading=11.7,textColor=PAPER if i==0 else INK)) for v in row] for i,row in enumerate(data)]
    widths=[CW/len(data[0])]*len(data[0])
    t=Table(rows,colWidths=widths,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),INK),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),('LINEBELOW',(0,1),(-1,-1),.5,LINE),('ROWBACKGROUNDS',(0,1),(-1,-1),[HexColor('#f2f1ed'),PAPER])]))
    _,ht=t.wrap(CW,H); t.drawOn(C,M,H-top-ht); BOUNDS.append((C.getPageNumber(),top,top+ht,'table'))
    return top+ht+13

def note(label,body,top):
    p=Paragraph(body,ParagraphStyle('note',fontName='Body',fontSize=10,leading=12.8,textColor=INK)); _,ht=p.wrap(CW-28,H)
    rect(M,top,CW,ht+34,HexColor('#edf2f8')); rect(M,top,3,ht+34,MUTED)
    text(M+13,top+10,label,8.4,'Mono',MUTED); p.drawOn(C,M+13,H-top-ht-27)
    BOUNDS.append((C.getPageNumber(),top,top+ht+34,'note')); return top+ht+39

def footer(page,refs):
    rule(718)
    links=[f'<link href="https://github.com/xlnfinance/xln/blob/{DATA["sha"]}/{r}">{escape(r)}</link>' for r in refs]
    para('SOURCE  '+' | '.join(links),M,727,CW,size=7.2,font='Mono',color=MUTED,leading=9)
    text(M,766,DATA['sha'][:12]+' · 06 OCT 2026 · RU / 1.0',7.6,'Mono',MUTED)
    text(W-M-15,765,str(page),9,'Sub')

def cover():
    rect(0,0,W,H,INK)
    for xx in range(0,613,18):
        C.setStrokeColor(HexColor('#172132')); C.setLineWidth(.35); C.line(xx,0,xx,H)
    for yy in range(0,793,18): C.line(0,yy,W,yy)
    text(M,64,'TECHNICAL MANUAL · CORE / 1.0',10,'Mono',HexColor('#ffaf60'))
    C.setStrokeColor(ORANGE); C.setLineWidth(1.5); C.line(M,H-86,M+100,H-86)
    text(M,120,'xln',106,'Head',HexColor('#ffffff'))
    para('Финансы как система<br/>проверяемых машин.',M,248,CW,size=23,font='Serif',color=HexColor('#d5dce7'),leading=31)
    d={'kind':'flow','height':165,'nodes':[['J','Расчёт и исполнение','J'],['E','Субъект и полномочия','E'],['A','Обязательства и баланс','A']], 'caption':'J/E/A - финансовая модель. Runtime исполняет и сохраняет её реплики.','caption_color':HexColor('#c3ccda')}
    diagram(d,356,1)
    para('Основные модули, протоколы и инварианты ядра.<br/>Объяснение по исходному коду с числовыми примерами.',M,563,CW,size=12,color=HexColor('#d5dce7'))
    C.setStrokeColor(HexColor('#344050')); C.line(M,H-674,W-M,H-674)
    for i,(label,value) in enumerate([('SUBJECT','xln · Jurisdiction / Entity / Account'),('BASELINE',DATA['sha'][:12]+' · main · 2026-10-06'),('AUDIENCE','Инженеры, архитекторы и финансовые институты')]):
        text(M,694+i*22,label,8,'Mono',HexColor('#ffaf60')); text(M+83,694+i*22,value,9,'Body',HexColor('#d5dce7'))
    C.bookmarkPage('page1'); C.addOutlineEntry('xln - техническое руководство','page1',0); C.showPage()

def contents():
    rect(0,0,W,H,PAPER); text(M,29,'XLN · TECHNICAL MANUAL',8.5,'Mono',MUTED)
    text(M,77,'Карта руководства',27,'Head'); rule(116,INK,1.5)
    yy=135
    groups=[('I · ФИНАНСОВАЯ МОДЕЛЬ',3,6,ORANGE),('II · RUNTIME И ENTITY',7,11,GREEN),('III · ACCOUNT И ОПЕРАЦИИ',12,20,BLUE),('IV · J И НАДЁЖНОСТЬ',21,28,PURPLE)]
    for title,start,end,color in groups:
        text(M,yy,title,8.6,'Mono',color); yy+=24
        for p in range(start,end+1):
            label=DATA['pages'][p-3]['title']; text(M+4,yy,label,10.5,'Sub')
            text(W-M-17,yy,str(p),9.5,'Mono',MUTED)
            C.linkRect('',f'page{p}',(M,H-yy-14,W-M,H-yy+2),relative=0,thickness=0); yy+=18
        yy+=14
    footer(2,['docs/core/rjea-architecture.md']); C.bookmarkPage('page2'); C.showPage()

cover(); contents(); FIG=1
for index,page in enumerate(DATA['pages'],3):
    rect(0,0,W,H,PAPER); C.bookmarkPage(f'page{index}'); C.addOutlineEntry(f'{index:02d} {page["title"]}',f'page{index}',1)
    text(M,29,'XLN · TECHNICAL MANUAL',8.5,'Mono',MUTED)
    C.setFillColor(MUTED); C.setFont('Mono',8); C.drawRightString(W-M,H-29-8*.82,page['part'])
    text(M,72,f'CHAPTER {index-2:02d}',8.5,'Mono',ORANGE)
    yy=para(escape(page['title']),M,93,CW,size=25,font='Head',leading=31)
    yy=para(page['deck'],M,yy+10,CW,size=12,font='Serif',color=MUTED,leading=16)+17
    rule(yy); yy+=17
    for d in page.get('diagrams',[]):
        d=dict(d)
        if d['kind'] in ('flow','panels'): d['height']=max(110,d.get('height',150)-25)
        if d['kind']=='tree': d['height']=145
        if index==3: d['kind']='jea'; d['height']=145
        d['height']-= {7:15,18:12,22:15,23:5,26:8}.get(index,0)
        FIG+=1; yy=diagram(d,yy,FIG)
    for block in page.get('blocks',[]):
        yy=para(block['h'],M,yy,CW,size=12,font='Sub',leading=15)+5
        yy=para(block['body'],M,yy,CW,size=10.4,leading=13.4)+11
    if page.get('table'): yy=table(page['table'],yy)
    if page.get('note'): yy=note(*page['note'],yy)
    if str(index) in DETAILS: FIG+=1; yy=diagram(DETAILS[str(index)],yy,FIG)
    if yy>707: raise ValueError(f'Page {index} overflow: {yy:.1f}')
    footer(index,page['refs']); C.showPage()
C.save()
md=['# xln - техническое руководство по ядру',f'Baseline: `{DATA["sha"]}`; 2026-10-06.','']
for i,p in enumerate(DATA['pages'],3):
    md += [f'## {i:02d}. {p["title"]}',p['deck'],'']
    for d in p.get('diagrams',[]): md += [f'**Схема:** {d["caption"]}', '```json',json.dumps(d,ensure_ascii=False,indent=2),'```','']
    if str(i) in DETAILS: md += [f'**Дополнительная схема:** {DETAILS[str(i)]["caption"]}','```json',json.dumps(DETAILS[str(i)],ensure_ascii=False,indent=2),'```','']
    for b in p.get('blocks',[]): md += ['### '+b['h'],b['body'],'']
    if p.get('table'):
        md += [' | '.join(row) for row in p['table']]+['']
    if p.get('note'): md += ['**'+p['note'][0]+'** '+p['note'][1],'']
    md += ['Sources: '+'; '.join(p['refs']),'']
(ROOT/'xln-core-technical-manual.md').write_text('\n'.join(md))
qa = Path('/tmp/xln-core-manual/layout.json'); qa.parent.mkdir(parents=True,exist_ok=True)
qa.write_text(json.dumps({'pages':len(DATA['pages'])+2,'figures':FIG,'bounds':BOUNDS},ensure_ascii=False,indent=2))
print(json.dumps({'pdf':str(OUT),'pages':len(DATA['pages'])+2,'figures':FIG,'bytes':OUT.stat().st_size}))
