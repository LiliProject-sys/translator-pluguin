using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

record Identity(long hwnd,uint pid,uint tid,string image,string className);
record Surface(Identity foreground,Identity focus,bool valid,long[] chain) {
 public string Token=>$"{foreground.hwnd}:{foreground.pid}:{focus.hwnd}:{focus.pid}:{focus.tid}";
}
record Sample(string path,string documentId,string title,string target,int page,int start,int end,string local,int offset,bool match);
static class Program {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [StructLayout(LayoutKind.Sequential)] struct Gui { public uint size,flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public int a,b,c,d; }
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid,ref Gui g);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p,int flags,StringBuilder b,ref int n);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("oleaut32.dll")] static extern int GetActiveObject(ref Guid id,IntPtr reserved,[MarshalAs(UnmanagedType.IUnknown)]out object? o);
 [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd;public uint message;public UIntPtr wParam;public IntPtr lParam;public uint time;public int x,y;public uint priv; }
 [DllImport("user32.dll")] static extern bool PeekMessage(out Msg m,IntPtr h,uint a,uint b,uint remove);
 [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg m);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg m);
 static void Pump(){while(PeekMessage(out var m,IntPtr.Zero,0,0,1)){TranslateMessage(ref m);DispatchMessage(ref m);}}
 static Identity Id(IntPtr h) {
  uint tid=GetWindowThreadProcessId(h,out var pid);var cls=new StringBuilder(129);if(h!=IntPtr.Zero)GetClassName(h,cls,cls.Capacity);
  var image=new StringBuilder(32768);var p=OpenProcess(0x1000,false,pid);
  if(p!=IntPtr.Zero)try{int n=image.Capacity;if(!QueryFullProcessImageName(p,0,image,ref n))image.Clear();}finally{CloseHandle(p);}
  return new(h.ToInt64(),pid,tid,image.ToString(),cls.ToString());
 }
 static Surface Env() {
  var h=GetForegroundWindow();var f=Id(h);var g=new Gui{size=(uint)Marshal.SizeOf<Gui>()};bool ok=f.tid!=0&&GetGUIThreadInfo(f.tid,ref g);
  var focus=Id(g.focus);var chain=new List<long>();var p=g.focus;bool belongs=false;
  for(int i=0;i<16&&p!=IntPtr.Zero;i++){if(chain.Contains(p.ToInt64()))break;chain.Add(p.ToInt64());if(p==h){belongs=true;break;}p=GetParent(p);}
  return new(f,focus,ok&&belongs&&g.focus!=h&&IsWindowVisible(g.focus),chain.ToArray());
 }
 static bool Pdf(Surface e)=>e.valid&&Path.GetFileName(e.foreground.image).Equals("wps.exe",StringComparison.OrdinalIgnoreCase)
  &&Path.GetFileName(e.focus.image).Equals("wpspdf.exe",StringComparison.OrdinalIgnoreCase)&&e.focus.className=="Qt5QWindowIcon"
  &&!string.IsNullOrEmpty(e.foreground.image)&&string.Equals(Path.GetDirectoryName(e.foreground.image),Path.GetDirectoryName(e.focus.image),StringComparison.OrdinalIgnoreCase);
 static bool Stable(Surface a,Surface b)=>Pdf(a)&&Pdf(b)&&a.foreground==b.foreground&&a.focus==b.focus&&a.chain.SequenceEqual(b.chain);
 static object? Get(object o,string n,params object[] args)=>o.GetType().InvokeMember(n,BindingFlags.GetProperty|BindingFlags.OptionalParamBinding,null,o,args);
 static object? Item(object o)=>o.GetType().InvokeMember("Item",BindingFlags.InvokeMethod,null,o,new object[]{1});
 static void Release(object? o){if(o!=null&&Marshal.IsComObject(o))Marshal.ReleaseComObject(o);}
 static string Hash(string s)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
 static string Fingerprint(string path){var f=new FileInfo(path);return Hash(Path.GetFullPath(path).ToUpperInvariant()+"|"+f.Length+"|"+f.LastWriteTimeUtc.Ticks);}
 static readonly Dictionary<string,string> Pages=new();
 static string? cacheIdentity;
 static readonly Dictionary<string,long> Timing=new();
 static bool Consistent(string text,string target,int start,int end)=>start>=0&&end>=start&&end<text.Length
  &&text.Substring(start,end-start+1).TrimEnd('\r','\n')==target;
 static bool Settle(Sample now,ref Sample? previous,ref int same) {
  same=now.match&&now==previous?same+1:now.match?1:0;previous=now;return same>=2;
 }
 static T Measure<T>(string key,Func<T> f){var sw=Stopwatch.StartNew();try{return f();}finally{Timing[key]=Timing.GetValueOrDefault(key)+(long)Math.Ceiling(sw.Elapsed.TotalMilliseconds);}}
 static Sample? Read(object app) {
  object? doc=null,sel=null,ranges=null,range=null;
  try {
   doc=Measure("activeDocument",()=>Get(app,"ActiveDocument"));if(doc==null)throw new InvalidOperationException();
   string path=Path.GetFullPath(Get(doc,"FullName") as string??throw new InvalidOperationException());
   if(!Path.GetExtension(path).Equals(".pdf",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException();
   string identity=Fingerprint(path);
   if(identity!=cacheIdentity){Pages.Clear();cacheIdentity=identity;}
   var sw=Stopwatch.StartNew();sel=Get(doc,"Selection");if(sel==null)return null;
   string target=(Get(sel,"Text",Type.Missing,Type.Missing,Type.Missing) as string??"").TrimEnd('\r','\n');
   ranges=Get(sel,"Range");if(ranges==null)return null;
   int count=Convert.ToInt32(Get(ranges,"Count"));
   if(count==0||target.Length==0)return null;
   if(count!=1||target.Length>500)throw new NotSupportedException();
   range=Item(ranges)??throw new InvalidOperationException();
   int page=Convert.ToInt32(Get(range,"pageIndex")),start=Convert.ToInt32(Get(range,"StartIndex")),end=Convert.ToInt32(Get(range,"EndIndex"));
   Timing["selectionRange"]=Timing.GetValueOrDefault("selectionRange")+(long)Math.Ceiling(sw.Elapsed.TotalMilliseconds);
   string local="";int offset=0;bool match=Measure("pageTextGate",()=>{
    if(page<0||start<0||end<start)return false;
    string key=identity+":"+page;
    if(!Pages.TryGetValue(key,out var text)){
     text=Get(doc,"PageText",page) as string??throw new InvalidOperationException();
     if(Pages.Count>=4)Pages.Remove(Pages.Keys.First());Pages[key]=text;
    }
    if(!Consistent(text,target,start,end))return false;
    int a=Math.Max(0,start-120),b=Math.Min(text.Length,end+121);
    // Do not bisect UTF-16 surrogate pairs at the local-fragment boundary.
    if(a>0&&char.IsLowSurrogate(text[a]))a--;
    if(b<text.Length&&char.IsLowSurrogate(text[b]))b++;
    local=text.Substring(a,b-a);offset=start-a;return true;
   });
   return new(path,identity,Path.GetFileName(path),target,page,start,end,local,offset,match);
  }finally{Release(range);Release(ranges);Release(sel);Release(doc);}
 }
 static Process? python;
 static bool resolverFailed;
 static string HelperRoot() {
  if(File.Exists(Path.Combine(AppContext.BaseDirectory,"python","worker.py")))return AppContext.BaseDirectory;
  var development=Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"../../.."));
  if(File.Exists(Path.Combine(development,"WpsPdfHelper.csproj"))&&File.Exists(Path.Combine(development,"python","worker.py")))return development;
  throw new DirectoryNotFoundException();
 }
 static string PythonExecutable(string root) {
  var bundled=Path.Combine(root,"runtime","python","python.exe");
  if(File.Exists(bundled))return bundled;
  // Only a source checkout may use a development interpreter override.
  if(File.Exists(Path.Combine(root,"WpsPdfHelper.csproj")))return Environment.GetEnvironmentVariable("ORANGE_WPS_PYTHON")??Path.Combine(root,".venv","Scripts","python.exe");
  throw new FileNotFoundException();
 }
 static void StopPython(){if(python==null)return;try{if(!python.HasExited){python.StandardInput.WriteLine("{\"op\":\"exit\"}");python.StandardInput.Flush();if(!python.WaitForExit(300))python.Kill(true);}}catch{try{python.Kill(true);}catch{}}finally{python.Dispose();python=null;}}
 static (string text,string source,string quality,string reason) Resolve(Sample s,string root) {
  try {
   if(resolverFailed)throw new InvalidOperationException();
   if(python==null){
    var executable=PythonExecutable(root);
    var info=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardInputEncoding=new UTF8Encoding(false),StandardOutputEncoding=Encoding.UTF8};
    info.ArgumentList.Add("-E");info.ArgumentList.Add("-s");info.ArgumentList.Add("-u");info.ArgumentList.Add(Path.Combine(root,"python","worker.py"));
    python=Process.Start(info)??throw new InvalidOperationException();
    python.ErrorDataReceived+=(_,_)=>{};python.BeginErrorReadLine();
   }
   python.StandardInput.WriteLine(JsonSerializer.Serialize(new{op="resolve",s.path,identity=s.documentId,s.target,count=1,ranges=new[]{new[]{s.page,s.start,s.end}},validation=new{match=s.match,s.local,targetOffset=s.offset}}));python.StandardInput.Flush();
   var task=python.StandardOutput.ReadLineAsync();var deadline=Stopwatch.StartNew();
   while(!task.IsCompleted&&deadline.ElapsedMilliseconds<2000){Pump();Thread.Sleep(5);}
   if(!task.IsCompleted)throw new TimeoutException();
   using var result=JsonDocument.Parse(task.Result??throw new IOException());var r=result.RootElement;
   string text=r.GetProperty("text").GetString()??"";
   if(r.GetProperty("ok").GetBoolean()&&text.Length>0&&text.Length<=2000)return(text,"pymupdf-sentence","exact","resolved");
   return(s.local,"wps-page-text","exact-location-fallback","resolver_unresolved");
  }catch{resolverFailed=true;StopPython();return(s.local,"wps-page-text","exact-location-fallback","resolver_unavailable");}
 }
 static object Empty(string status,string reason)=>new{status,snapshot=(object?)null,reason,timingMs=Timing};
 static object Capture(string id,string expected,string root) {
  Timing.Clear();var total=Stopwatch.StartNew();object? app=null;
  try {
   var before=Measure("hostProbe",Env);
   if(!Pdf(before))return Empty("INDETERMINATE","surface_unknown");
   if(before.Token!=expected)return Empty("UNSTABLE","surface_changed");
   Measure("activeDocument",()=>{var clsid=new Guid("6F13E9B3-DDE3-4EC5-9E2E-81BC3135401E");int hr=GetActiveObject(ref clsid,IntPtr.Zero,out app);if(hr!=0||app==null)throw new InvalidOperationException();return true;});
   Sample? previous=null,accepted=null;int same=0;var settle=Stopwatch.StartNew();
   do {
    Pump();var now=Read(app!);
    if(!Stable(before,Env()))return Empty("UNSTABLE","surface_changed");
    if(now==null)return Empty("NO_SELECTION","no_selection");
    if(previous!=null&&previous.documentId!=now.documentId)return Empty("UNSTABLE","document_changed");
    if(Settle(now,ref previous,ref same)){accepted=now;break;}
    Thread.Sleep(15);
   }while(settle.ElapsedMilliseconds<250);
   Timing["settling"]=(long)Math.Ceiling(settle.Elapsed.TotalMilliseconds);
   if(accepted==null)return Empty("UNSTABLE","selection_inconsistent");
   var context=Measure("resolver",()=>Resolve(accepted,root));
   // Re-read selection AND document after potentially slow file-side resolution.
   var after=Read(app!);
   if(after!=accepted||!Stable(before,Measure("hostProbe",Env))||Fingerprint(accepted.path)!=accepted.documentId)return Empty("UNSTABLE","capture_changed");
   var snapshot=new{snapshotId=id,capturedAt=DateTime.UtcNow.ToString("O"),host=new{adapterId="wps-pdf",appKind="wps-pdf"},target=new{text=accepted.target},
    document=new{documentId=accepted.documentId,title=accepted.title},occurrence=new{kind="wps-pdf-range",pageIndex=accepted.page,startIndex=accepted.start,endIndex=accepted.end},
    context=new{context.text,context.source,context.quality}};
   return new{status="OK",snapshot,reason=context.reason,timingMs=Timing};
  }catch(NotSupportedException){return Empty("INDETERMINATE","unsupported_selection");}
  catch{Pages.Clear();cacheIdentity=null;return Empty("ERROR","com_capture_failed");}
  finally{Release(app);Timing["totalCapture"]=(long)Math.Ceiling(total.Elapsed.TotalMilliseconds);}
 }
 [STAThread] static int Main(string[] args) {
  Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
  if(args.SequenceEqual(new[]{"--self-test"})){try{SelfTest();}finally{StopPython();}return 0;}
  if(args.Length==2&&args[0]=="--self-test-resolver") {
   try {
    var sample=new Sample(Path.GetFullPath(args[1]),"synthetic-v1","public.pdf","component",0,5,13,"This component is useful.",5,true);
    var result=Resolve(sample,HelperRoot());
    if(result.source!="pymupdf-sentence"||result.quality!="exact"||result.text!="This component is useful.")return 1;
    Console.WriteLine("Bundled helper-to-Python synthetic resolution passed.");return 0;
   }finally{StopPython();}
  }
  if(args.Length==2&&args[0]=="--test-transport") {
   Console.ReadLine();if(args[1]=="malformed")Console.WriteLine("not-json");return 0;
  }
  string root;
  try{root=HelperRoot();}catch{return 1;}
  try {
   string? line;
   while((line=Console.ReadLine())!=null){
    object result;
    try{using var request=JsonDocument.Parse(line);var r=request.RootElement;
     if(r.GetProperty("op").GetString()=="exit")break;
     if(r.GetProperty("op").GetString()!="capture"||line.Length>1024)throw new InvalidOperationException();
     result=Capture(r.GetProperty("interactionId").GetString()!,r.GetProperty("surfaceToken").GetString()!,root);
    }catch{Timing.Clear();result=Empty("ERROR","invalid_request");}
    Console.WriteLine(JsonSerializer.Serialize(result));Console.Out.Flush();
   }
  }finally{StopPython();Pages.Clear();}
  return 0;
 }
 static void SelfTest() {
  var f=new Identity(1,2,3,@"D:\office6\wps.exe","OpusApp");
  var p=new Identity(4,5,6,@"D:\office6\wpspdf.exe","Qt5QWindowIcon");
  var s=new Surface(f,p,true,new long[]{4,1});
  void Check(bool ok){if(!ok)throw new Exception("contract check failed");}
  Check(Pdf(s));Check(Stable(s,s));Check(!Stable(s,s with{focus=p with{hwnd=7}}));
  Check(!Pdf(s with{valid=false}));Check(!Pdf(s with{focus=p with{className="Edit"}}));
  Check(!Pdf(s with{focus=p with{image=@"D:\other\wpspdf.exe"}}));
  Check(!Stable(s,s with{chain=new long[]{4,8,1}}));
  var a=new Sample("test.pdf","id","test.pdf","word",0,2,5,"a word b",2,true);
  Check(a==a with{});Check(a!=a with{documentId="other"});Check(a!=a with{start=7,end=10});
  var text="😀word\r\n";Check(Consistent(text,"word",2,7));
  Check(!Consistent(text,"word",2,4));Check(!Consistent(text,"word",-1,4));Check(!Consistent(text,"word",2,99));
  Sample? previous=null;int same=0;
  Check(!Settle(a with{match=false},ref previous,ref same));Check(!Settle(a,ref previous,ref same));Check(Settle(a,ref previous,ref same));
  Check(!Settle(a with{start=9,end=12},ref previous,ref same));
  var fallback=Resolve(a,HelperRoot());
  Check(fallback.text==a.local&&fallback.source=="wps-page-text"&&fallback.quality=="exact-location-fallback");
  Console.WriteLine("19 surface/document/UTF16/settling/fallback checks passed; no live COM.");
 }
}
