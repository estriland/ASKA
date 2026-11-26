"""Explicit user uploads: local snapshots, bounded extraction, no file execution."""
import json
import shutil
import uuid
import zipfile
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from PyQt6.QtCore import QSize, QThread, pyqtSignal
from PyQt6.QtPdf import QPdfDocument
from PyQt6 import sip
from core.app_config import PROJECT_ROOT
from core.image_attachment import prepare_chat_image, encode_chat_image

MAX_FILE_BYTES=32*1024*1024
MAX_TEXT=500_000
MAX_IMAGES=16
MARKER='\n\n[ASUKA_FILE_PAYLOAD_V1]\n'
IMAGE_SUFFIXES={'.png','.jpg','.jpeg','.webp','.bmp','.gif','.tif','.tiff','.ico','.jfif','.jpe','.avif','.heic','.heif','.pbm','.pgm','.ppm','.xbm','.xpm'}

def pdf_content(path,vision,interrupted):
    doc=QPdfDocument(None)
    try:
        error=doc.load(str(path))
        if error!=QPdfDocument.Error.None_:raise ValueError('PDF无法打开，可能已加密或损坏')
        count=doc.pageCount()
        if not 0<count<=500:raise ValueError('PDF页数须在1–500之间，请拆分文件')
        texts=[];images=[];chars=0;missing=[];image_pages=[]
        preview=vision and count<=MAX_IMAGES
        for i in range(count):
            if interrupted():raise ValueError('已取消文件解析')
            text=doc.getAllText(i).text()
            chars+=len(text)
            if chars>MAX_TEXT:raise ValueError('PDF全文过长，请拆分；没有截断发送')
            if not text.strip():missing.append(i+1)
            texts.append(f'【第{i+1}/{count}页】\n'+(text or '（无可提取文字）'))
            if preview or (vision and not text.strip()):
                if len(images)>=MAX_IMAGES:raise ValueError('扫描页超过16页，请拆分后上传；没有只发送前16页')
                size=doc.pagePointSize(i)
                scale=1200/max(size.width(),size.height())
                raster=doc.render(i,QSize(max(1,int(size.width()*scale)),max(1,int(size.height()*scale))))
                if raster.isNull():raise ValueError(f'第{i+1}页渲染失败')
                images.append(encode_chat_image(raster,max_bytes=1024*1024)[0])
                image_pages.append(i+1)
        if missing and not vision:
            raise ValueError(f'第{",".join(map(str,missing[:12]))}页没有文字层；请用视觉模型，扫描PDF每份最多{MAX_IMAGES}页')
        note=f'PDF共{count}页，已逐页提取文字；'+('同时附全部页面图像，顺序与页码一致' if preview else '以全文文字为主，文字页的图表/版面未发送（完整视觉预览限16页）')
        if image_pages:note+='；本文件附图按顺序对应PDF页码：'+','.join(map(str,image_pages))
        else:note+='；仅发送文字'
        return '\n\n'.join(texts),images,note
    finally:
        doc.close();sip.delete(doc)

def office_content(path):
    # Never extract ZIP entries to disk or load macros/external relationships.
    with zipfile.ZipFile(path) as archive:
        if sum(x.file_size for x in archive.infolist())>64*1024*1024:raise ValueError('Office解压内容过大')
        names=archive.namelist();suffix=path.suffix.lower()
        if suffix=='.docx':parts=[n for n in names if n=='word/document.xml' or re.fullmatch(r'word/(header\d+|footer\d+|footnotes|endnotes).xml',n)]
        elif suffix=='.pptx':parts=sorted([n for n in names if re.fullmatch(r'ppt/slides/slide\d+.xml',n)],key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
        else:parts=sorted([n for n in names if re.fullmatch(r'xl/worksheets/sheet\d+.xml',n)],key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
        if not parts:raise ValueError('Office文档缺少正文')
        shared=[]
        if 'xl/sharedStrings.xml' in names:
            tree=ET.fromstring(archive.read('xl/sharedStrings.xml'))
            shared=[''.join(t.text or '' for t in item.iter() if t.tag.endswith('}t')) for item in tree]
        sections=[]
        for part in parts:
            tree=ET.fromstring(archive.read(part));lines=[]
            if suffix=='.xlsx':
                for row in tree.iter():
                    if not row.tag.endswith('}row'):continue
                    cells=[]
                    for cell in row:
                        values=[n.text or '' for n in cell if n.tag.endswith('}v')]
                        value=''.join(values)
                        if cell.get('t')=='s' and value:value=shared[int(value)]
                        elif cell.get('t')=='inlineStr':value=''.join(n.text or '' for n in cell.iter() if n.tag.endswith('}t'))
                        formula=next((n.text for n in cell if n.tag.endswith('}f')),None)
                        cells.append(cell.get('r','')+': '+value+(f' [公式={formula}]' if formula else ''))
                    lines.append(' | '.join(cells))
            else:
                for paragraph in tree.iter():
                    if paragraph.tag.endswith('}p'):lines.append(''.join(n.text or '' for n in paragraph.iter() if n.tag.endswith('}t')))
            sections.append('【'+part+'】\n'+'\n'.join(lines))
        return '\n\n'.join(sections)

def prepare_chat_file(source,vision=False,cache_root=None,interrupted=lambda:False):
    source=Path(source)
    if not source.is_file():raise ValueError('只支持文件，不支持目录')
    if source.stat().st_size>MAX_FILE_BYTES:raise ValueError('单文件最多32MB，请拆分后上传')
    folder=Path(cache_root or PROJECT_ROOT/'data/chat_uploads')/uuid.uuid4().hex
    folder.mkdir(parents=True);snapshot=folder/source.name
    try:
        shutil.copyfile(source,snapshot)
        if snapshot.stat().st_size>MAX_FILE_BYTES:raise ValueError('文件过大')
        ext=snapshot.suffix.lower();images=[];text='';note=''
        if ext in IMAGE_SUFFIXES:
            if not vision:raise ValueError('当前模型不支持图片，请切换视觉模型')
            images=[prepare_chat_image(snapshot)[0]];note='图片已编码；动画/多帧图片仅采用首帧'
        elif ext=='.pdf':text,images,note=pdf_content(snapshot,vision,interrupted)
        elif ext in {'.docx','.xlsx','.pptx'}:
            text=office_content(snapshot);note='已提取正文文字；不执行宏/公式，不发送内嵌图片及原版式'
        else:
            raw=snapshot.read_bytes()
            if raw.startswith((b'\xff\xfe',b'\xfe\xff')):text=raw.decode('utf-16')
            else:
                if b'\0' in raw:raise ValueError('不支持此二进制格式；请转为PDF、Office或文本。音视频/压缩包/程序不会被执行')
                try:text=raw.decode('utf-8-sig')
                except UnicodeDecodeError:
                    try:text=raw.decode('gb18030')
                    except UnicodeDecodeError:raise ValueError('无法识别文本编码，请另存为UTF-8')
            if any(ord(c)<32 and c not in '\n\r\t\f' for c in text):raise ValueError('文件包含非文本控制字节，拒绝作为文本发送')
            note='全文文本已读取'
        if len(text)>MAX_TEXT:raise ValueError('文件文字超过50万字符，请拆分；没有截断发送')
        if not text.strip() and not images:raise ValueError('文件没有可读取的内容')
        if interrupted():raise ValueError('已取消文件解析')
        return {'name':source.name,'path':str(snapshot),'text':text,'images':images,'note':note,'bytes':snapshot.stat().st_size,'is_image':ext in IMAGE_SUFFIXES}
    except Exception:
        snapshot.unlink(missing_ok=True);folder.rmdir();raise

def file_message(text,files):
    if not files:return text,[]
    if len(files)>8:raise ValueError('每条消息最多8个文件')
    images=[image for f in files for image in f['images']]
    if len(images)>MAX_IMAGES:raise ValueError('本条消息的图片/页面合计超过16张，请分次发送')
    if sum(len(i['data']) for i in images)>24*1024*1024:raise ValueError('附件图像总量过大，请分次发送')
    if sum(len(f['text']) for f in files)>MAX_TEXT:raise ValueError('附件文本合计超过50万字符，请分次发送')
    payload=[];index=1
    for f in files:
        count=len(f['images']);payload.append({'name':f['name'],'note':f['note'],'image_indices':list(range(index,index+count)),'text':f['text']});index+=count
    return (text or '请阅读附件。')+MARKER+json.dumps(payload,ensure_ascii=False),images

def visible_file_message(text):
    if MARKER not in text:return text
    head,tail=text.split(MARKER,1)
    try:files=json.loads(tail);return head+'\n\n'+'\n\n'.join('附件：'+f['name'] for f in files)
    except (ValueError,TypeError,KeyError):return text

class FilePreparation(QThread):
    prepared=pyqtSignal(list,list)
    def __init__(self,paths,vision,parent=None):super().__init__(parent);self.paths=paths;self.vision=vision
    def run(self):
        files=[];errors=[]
        for path in self.paths:
            if self.isInterruptionRequested():break
            try:files.append(prepare_chat_file(path,self.vision,interrupted=self.isInterruptionRequested))
            except Exception as e:errors.append(Path(path).name+'：'+str(e))
        self.prepared.emit(files,errors)
