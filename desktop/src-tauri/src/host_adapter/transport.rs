use super::{decode, CaptureStatus, SelectionRuntimeState};
use std::{ffi::c_void, io::{BufRead, BufReader, Read, Write}, os::windows::{io::AsRawHandle, process::CommandExt}, process::{Child, ChildStdin, Command, Stdio}, sync::mpsc::{self, Receiver}, thread, time::{Duration, Instant}};
type Handle = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct Limits { process_time:i64, job_time:i64, flags:u32, min:usize, max:usize, processes:u32, affinity:usize, priority:u32, scheduling:u32, io:[u64;6], process_memory:usize, job_memory:usize, peak_process:usize, peak_job:usize }
#[link(name="kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes:Handle,name:*const u16)->Handle;
    fn SetInformationJobObject(job:Handle,class:i32,data:*const Limits,size:u32)->i32;
    fn AssignProcessToJobObject(job:Handle,process:Handle)->i32;
    fn CloseHandle(handle:Handle)->i32;
}
struct OwnedProcess { child:Child, input:ChildStdin, output:Receiver<String>, job:Handle }
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _=writeln!(self.input,"{{\"op\":\"exit\"}}");
        let _=self.input.flush();
        let start=Instant::now();
        while start.elapsed()<Duration::from_millis(750) {
            if self.child.try_wait().ok().flatten().is_some(){break;}
            thread::sleep(Duration::from_millis(10));
        }
        // KILL_ON_JOB_CLOSE applies only to our helper and its resolver descendant.
        unsafe { CloseHandle(self.job); }
        let _=self.child.wait();
    }
}
#[derive(Default)]
pub struct Helper {
    process:Option<OwnedProcess>, failures:u8,
    #[cfg(test)] test_mode:Option<&'static str>,
    #[cfg(test)] starts:usize,
}

// A release must use its own runtime, never a development checkout or PATH.
fn bundled_paths(base:&std::path::Path)->(std::path::PathBuf,std::path::PathBuf) {
    let root=base.join("helpers/wps-pdf");
    (root.join("runtime/dotnet/dotnet.exe"),root.join("WpsPdfHelper.dll"))
}
fn helper_command()->Result<Command,()> {
    let exe=std::env::current_exe().map_err(|_|())?;
    let (runtime,assembly)=bundled_paths(exe.parent().ok_or(())?);
    if runtime.is_file() && assembly.is_file() {
        let mut command=Command::new(&runtime);
        command.arg(assembly).env("DOTNET_ROOT",runtime.parent().ok_or(())?)
            .env("DOTNET_MULTILEVEL_LOOKUP","0");
        return Ok(command);
    }
    #[cfg(debug_assertions)]
    {
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../helpers/wps-pdf/bin/Release/net8.0-windows/WpsPdfHelper.dll");
        let mut command=Command::new("dotnet");command.arg(path);return Ok(command);
    }
    #[cfg(not(debug_assertions))]
    Err(())
}
impl Helper {
    fn start(&mut self)->Result<(),()> {
        if self.failures>=2 {return Err(());}
        let mut command=helper_command()?;command.creation_flags(0x08000000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(test)]
        { if let Some(mode)=self.test_mode {command.arg("--test-transport").arg(mode);} self.starts+=1; }
        let mut child=command.spawn().map_err(|_|())?;
        let job=unsafe {CreateJobObjectW(std::ptr::null_mut(),std::ptr::null())};
        let limits=Limits{flags:0x2000,..Default::default()};
        if job.is_null() || unsafe{SetInformationJobObject(job,9,&limits,std::mem::size_of::<Limits>() as u32)}==0
            || unsafe{AssignProcessToJobObject(job,child.as_raw_handle())}==0 {
            let _=child.kill();let _=child.wait();if !job.is_null(){unsafe{CloseHandle(job);}}return Err(());
        }
        let input=child.stdin.take().ok_or(())?;
        let output=child.stdout.take().ok_or(())?;
        let (tx,rx)=mpsc::sync_channel(1);
        thread::spawn(move||{
            let mut reader=BufReader::new(output);
            loop {
                let mut line=String::new();
                match (&mut reader).take(32769).read_line(&mut line) {
                    Ok(n) if n>0 && n<=32768 && line.ends_with('\n') => {if tx.send(line).is_err(){break;}},
                    _=>break,
                }
            }
        });
        self.process=Some(OwnedProcess{child,input,output:rx,job});Ok(())
    }
    pub fn capture(&mut self,id:&str,surface:&str)->SelectionRuntimeState {
        let started=Instant::now();
        let result=(||{
            if self.process.is_none(){self.start()?;}
            let p=self.process.as_mut().ok_or(())?;
            let request=serde_json::json!({"op":"capture","interactionId":id,"surfaceToken":surface});
            writeln!(p.input,"{request}").map_err(|_|())?;p.input.flush().map_err(|_|())?;
            let line=p.output.recv_timeout(Duration::from_secs(5)).map_err(|_|())?;
            decode(&line,id)
        })();
        let mut state=match result {
            Ok(r)=>r,
            Err(())=>{self.process.take();self.failures=self.failures.saturating_add(1);SelectionRuntimeState::empty(CaptureStatus::Error,"helper_unavailable")},
        };
        state.timing_ms.insert("helperIpc".into(),started.elapsed().as_millis() as u64);state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_paths_follow_the_executable_directory() {
        for base in [r"D:\Portable\Orange",r"E:\新目录 空格\Orange"] {
            let base=std::path::Path::new(base);
            let (runtime,assembly)=bundled_paths(base);
            assert_eq!(runtime,base.join("helpers/wps-pdf/runtime/dotnet/dotnet.exe"));
            assert_eq!(assembly,base.join("helpers/wps-pdf/WpsPdfHelper.dll"));
        }
    }
    #[test]
    fn malformed_and_crashed_owned_helpers_restart_once_then_stop() {
        for mode in ["malformed","crash"] {
            let mut helper=Helper{test_mode:Some(mode),..Default::default()};
            for _ in 0..3 {assert_eq!(helper.capture("test","0").status,CaptureStatus::Error);}
            assert_eq!(helper.starts,2);assert!(helper.process.is_none());
        }
    }
}
